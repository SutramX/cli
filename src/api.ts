import { VERSION } from './version.js';

export const DEFAULT_API_URL = 'https://api.sutramx.com';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const OFFICIAL_HOST = /(^|\.)sutramx\.com$/i;

/**
 * The API key travels in every request, so the base URL must be https
 * (plain http only for loopback development servers). Returns the
 * normalised URL; throws on anything else.
 */
export function validateApiUrl(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`Invalid API URL: ${JSON.stringify(raw.slice(0, 200))}`);
    }
    if (parsed.username || parsed.password) throw new Error('The API URL must not contain credentials.');
    if (parsed.search || parsed.hash) throw new Error('The API URL must not contain a query string or fragment.');
    const loopback = LOOPBACK.has(parsed.hostname.toLowerCase());
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        throw new Error(`Refusing to send the API key to ${parsed.origin}: the API URL must use https:// (plain http is only allowed for localhost).`);
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/** True for api.sutramx.com and other *.sutramx.com hosts, and loopback. */
export function isTrustedApiHost(baseUrl: string): boolean {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return OFFICIAL_HOST.test(host) || LOOPBACK.has(host);
}

const warned = new Set<string>();
function warnOnce(message: string) {
    if (warned.has(message)) return;
    warned.add(message);
    process.stderr.write(`Warning: ${message}\n`);
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter !== null ? Number(retryAfter) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), MAX_RETRY_DELAY_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
    constructor(public readonly status: number, message: string, public readonly code?: string, public readonly details?: unknown) {
        super(message);
        this.name = 'ApiError';
    }
}

/** The backend answers errors in three shapes; normalise them. */
export function parseErrorBody(status: number, body: unknown): ApiError {
    if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (record.error && typeof record.error === 'object') {
            const nested = record.error as Record<string, unknown>;
            return new ApiError(status, String(nested.message || `HTTP ${status}`), nested.code ? String(nested.code) : undefined, nested.details);
        }
        if (typeof record.error === 'string') {
            const fieldErrors = Array.isArray(record.errors)
                ? (record.errors as Array<{ field?: string; message?: string; }>).map((e) => (e.field ? `${e.field}: ${e.message}` : String(e.message))).join('; ')
                : '';
            return new ApiError(status, fieldErrors ? `${record.error}: ${fieldErrors}` : record.error, record.code ? String(record.code) : undefined, record.details ?? record.errors ?? record);
        }
    }
    return new ApiError(status, `HTTP ${status}`);
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class SutramXApi {
    readonly baseUrl: string;

    /** Delay between retries; tests set it to 0. */
    retryDelay: (attempt: number, retryAfter: string | null) => number = retryDelayMs;

    constructor(private readonly apiKey: string, baseUrl: string = DEFAULT_API_URL) {
        this.baseUrl = validateApiUrl(baseUrl);
        if (apiKey && !isTrustedApiHost(this.baseUrl)) {
            warnOnce(`sending your SutramX API key to ${new URL(this.baseUrl).host}, which is not a sutramx.com host. Check SUTRAMX_API_URL / --api-url.`);
        }
        if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
            warnOnce('NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate checks; your API key can be intercepted.');
        }
    }

    async request<T>(method: string, path: string, options: { query?: Query; body?: unknown; anonymous?: boolean; } = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query || {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `sutramx-cli/${VERSION}` };
        if (!options.anonymous) headers.Authorization = `Bearer ${this.apiKey}`;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        // Retries: 429 for any method (the request was refused, not run);
        // 502/503/504 and network errors only for idempotent methods.
        const idempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
        let response: Response | undefined;
        for (let attempt = 0; ; attempt += 1) {
            const last = attempt >= MAX_ATTEMPTS - 1;
            try {
                response = await fetch(url, {
                    method,
                    headers,
                    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    // Never follow redirects: the API does not redirect, and a
                    // redirect must not carry the key to another place.
                    redirect: 'error',
                });
            } catch (error) {
                if (idempotent && !last) {
                    await sleep(this.retryDelay(attempt, null));
                    continue;
                }
                throw new ApiError(0, `Could not reach ${this.baseUrl}: ${(error as Error).message}`);
            }
            const retryable = response.status === 429 || (idempotent && [502, 503, 504].includes(response.status));
            if (!retryable || last) break;
            await response.body?.cancel().catch(() => undefined);
            await sleep(this.retryDelay(attempt, response.headers.get('retry-after')));
        }
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        let body: unknown;
        try {
            body = text ? JSON.parse(text) : undefined;
        } catch {
            body = text;
        }
        // 207: a declarative apply that partly failed still carries results.
        if (!response.ok) throw parseErrorBody(response.status, body);
        return body as T;
    }

    get<T>(path: string, query?: Query) { return this.request<T>('GET', path, { query }); }
    getPublic<T>(path: string, query?: Query) { return this.request<T>('GET', path, { query, anonymous: true }); }
    post<T>(path: string, body: unknown = {}) { return this.request<T>('POST', path, { body }); }
    put<T>(path: string, body: unknown = {}) { return this.request<T>('PUT', path, { body }); }
    patch<T>(path: string, body: unknown = {}) { return this.request<T>('PATCH', path, { body }); }
    delete<T>(path: string) { return this.request<T>('DELETE', path); }
}

/** One-line explanation with a hint for common failures. */
export function describeError(error: unknown): string {
    if (!(error instanceof ApiError)) return (error as Error)?.message || String(error);
    const code = error.code ? ` ${error.code}` : '';
    let hint = '';
    if (error.status === 401) hint = 'Run `sutramx login` or set SUTRAMX_API_KEY.';
    else if (error.code === 'AUTOMATION_KEY_REQUIRED') hint = 'Managing integrations needs an API key created with "Automation access".';
    else if (error.code === 'ENTITLEMENT_LIMIT_REACHED' || error.code === 'FEATURE_NOT_AVAILABLE') hint = 'Your plan does not allow this; see `sutramx whoami`.';
    else if (error.status === 429) hint = 'Rate limited; wait a few minutes.';
    let detail = '';
    const specs = (error.details as { specs?: Array<{ key: string | null; index: number; errors: string[]; }>; } | undefined)?.specs;
    if (Array.isArray(specs)) {
        detail = specs.map((spec) => `\n  monitor ${spec.key ?? `#${spec.index + 1}`}: ${spec.errors.join('; ')}`).join('');
    }
    return `${error.message} (HTTP ${error.status}${code})${detail}${hint ? `\n${hint}` : ''}`;
}
