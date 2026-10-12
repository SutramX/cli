import { randomUUID } from 'node:crypto';
import { VERSION } from './version.js';

export const DEFAULT_API_URL = 'https://api.sutramx.com';
/** Per attempt; SUTRAMX_TIMEOUT (seconds) overrides it. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Per attempt for calls that do real work while the client waits (run-check, plan, apply). */
export const LONG_TIMEOUT_MS = 120_000;
/** A call with its retries gives up after this many per-attempt timeouts. */
const DEADLINE_ATTEMPTS = 3;
const MAX_ATTEMPTS = 4;
/** A longer Retry-After is not waited for: the error is reported instead. */
const MAX_RETRY_DELAY_MS = 30_000;
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
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

/** Text from the server, safe for one terminal line. */
function oneLine(text: string, max = 200): string {
    const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Exit codes (documented in the README). 2 is "plan has changes" (--detailed-exitcode), never an error. */
export const EXIT = {
    ERROR: 1,
    CHANGES: 2,
    AUTH: 3,
    NOT_FOUND: 4,
    RATE_LIMITED: 5,
    NETWORK: 6,
    PLAN_LIMIT: 7,
    USAGE: 8,
} as const;

/** Error codes that mean "your plan does not allow this": retrying does not help. */
export const PLAN_LIMIT_CODES: ReadonlySet<string> = new Set([
    'ENTITLEMENT_LIMIT_REACHED', 'ENTITLEMENT_INTERVAL_TOO_SHORT', 'MONITOR_TOTAL_LIMIT_REACHED', 'CONNECTION_LIMIT_REACHED',
    'LIMIT_REACHED', 'AI_LIMIT_REACHED', 'FEATURE_NOT_AVAILABLE',
]);

/**
 * Retry-After as milliseconds: delta-seconds ("120") or an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). null when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
    const date = Date.parse(trimmed);
    if (!/[a-z]/i.test(trimmed) || Number.isNaN(date)) return null;
    return Math.max(0, date - now);
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
    const fromHeader = parseRetryAfter(retryAfter);
    if (fromHeader !== null) return fromHeader;
    return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), MAX_RETRY_DELAY_MS);
}

/** SUTRAMX_TIMEOUT in seconds (decimals allowed), or undefined. */
export function timeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const raw = env.SUTRAMX_TIMEOUT;
    if (raw === undefined || raw.trim() === '') return undefined;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        warnOnce(`SUTRAMX_TIMEOUT must be a number of seconds greater than 0; ignoring ${JSON.stringify(raw.slice(0, 40))}.`);
        return undefined;
    }
    return Math.round(seconds * 1000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApiError extends Error {
    /** `category` from the error body (e.g. PLAN_LIMIT). */
    category?: string;
    /** From a Retry-After header, in milliseconds. */
    retryAfterMs?: number;

    constructor(public readonly status: number, message: string, public readonly code?: string, public readonly details?: unknown) {
        super(message);
        this.name = 'ApiError';
    }
}

/** The API could not be reached (DNS, refused, timeout, TLS ...): status 0. */
export class NetworkError extends ApiError {
    constructor(message: string, public readonly causeCode: string | undefined, public readonly host: string, public readonly timedOut: boolean) {
        super(0, message, causeCode);
        this.name = 'NetworkError';
    }
}

const TLS_CODES = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);

function isTlsCode(code: string | undefined): boolean {
    return Boolean(code && (code.startsWith('CERT_') || TLS_CODES.has(code)));
}

/** fetch() rejections carry the useful part in `cause` (sometimes nested). */
function networkError(error: unknown, host: string, timeoutMs: number): NetworkError {
    const err = error as (Error & { code?: string; cause?: unknown; }) | undefined;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    if (timedOut) {
        return new NetworkError(`Could not reach ${host} (ETIMEDOUT): no response within ${timeoutMs / 1000}s`, 'ETIMEDOUT', host, true);
    }
    let cause: (Error & { code?: string; cause?: unknown; }) | undefined = err;
    let code: string | undefined;
    let detail = err?.message || String(error);
    for (let depth = 0; cause && depth < 4; depth += 1) {
        if (typeof cause.code === 'string' && !code) code = cause.code;
        if (cause !== err && cause.message) detail = cause.message;
        cause = cause.cause as typeof cause;
    }
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') code = 'ETIMEDOUT';
    return new NetworkError(`Could not reach ${host}${code ? ` (${code})` : ''}: ${oneLine(detail)}`, code, host, code === 'ETIMEDOUT');
}

/** Network failures worth another attempt (not TLS or redirect refusals, not a typo'd host). */
function retryableNetworkError(error: NetworkError): boolean {
    if (isTlsCode(error.causeCode) || error.causeCode === 'ENOTFOUND') return false;
    return !/redirect/i.test(error.message);
}

/** The backend answers errors in three shapes; normalise them. */
export function parseErrorBody(status: number, body: unknown): ApiError {
    if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        const category = typeof record.category === 'string' ? record.category : undefined;
        if (record.error && typeof record.error === 'object') {
            const nested = record.error as Record<string, unknown>;
            const error = new ApiError(status, String(nested.message || `HTTP ${status}`), nested.code ? String(nested.code) : undefined, nested.details);
            error.category = category ?? (typeof nested.category === 'string' ? nested.category : undefined);
            return error;
        }
        if (typeof record.error === 'string') {
            const fieldErrors = Array.isArray(record.errors)
                ? (record.errors as Array<{ field?: string; message?: string; }>).map((e) => (e.field ? `${e.field}: ${e.message}` : String(e.message))).join('; ')
                : '';
            const error = new ApiError(status, fieldErrors ? `${record.error}: ${fieldErrors}` : record.error, record.code ? String(record.code) : undefined, record.details ?? record.errors ?? record);
            error.category = category;
            return error;
        }
    }
    // Plain text (older rate limiters, proxies): keep a readable excerpt, not an HTML page.
    if (typeof body === 'string' && body.trim() && !body.trimStart().startsWith('<')) {
        return new ApiError(status, oneLine(body), status === 429 ? 'RATE_LIMITED' : undefined);
    }
    return new ApiError(status, `HTTP ${status}`, status === 429 ? 'RATE_LIMITED' : undefined);
}

/** Parsed JSON, the text itself when it is not JSON, undefined when empty. */
function parseJson(text: string): unknown {
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function errorCodeOf(text: string): string | undefined {
    return parseErrorBody(0, parseJson(text)).code;
}

export function isPlanLimit(error: unknown): boolean {
    return error instanceof ApiError && (error.category === 'PLAN_LIMIT' || (error.code !== undefined && PLAN_LIMIT_CODES.has(error.code)));
}

/** Process exit code for an API failure (see EXIT). */
export function exitCodeForApiError(error: ApiError): number {
    if (error instanceof NetworkError) return EXIT.NETWORK;
    if (isPlanLimit(error)) return EXIT.PLAN_LIMIT;
    if (error.status === 401 || error.status === 403) return EXIT.AUTH;
    if (error.status === 404) return EXIT.NOT_FOUND;
    if (error.status === 429) return EXIT.RATE_LIMITED;
    if (error.status === 400 || error.status === 422) return EXIT.USAGE;
    return EXIT.ERROR;
}

/** Reads the body, refusing more than `limit` bytes. */
async function readBody(response: Response, limit: number, host: string): Promise<string> {
    const tooLarge = () => new ApiError(response.status, `The response from ${host} is larger than ${Math.round(limit / 1024 / 1024)} MB; refusing to read it`, 'RESPONSE_TOO_LARGE');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLarge();
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel().catch(() => undefined);
            throw tooLarge();
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

interface Transport {
    fetch: typeof fetch;
    dispatcher?: unknown;
}

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
let proxyTransport: { signature: string; transport: Promise<Transport>; } | undefined;

/**
 * HTTPS_PROXY / HTTP_PROXY / NO_PROXY: Node's fetch ignores them, so when one
 * is set the request goes through undici's EnvHttpProxyAgent (which reads
 * all three). Without a proxy variable nothing extra is loaded.
 */
async function transport(env: NodeJS.ProcessEnv = process.env): Promise<Transport> {
    if (!PROXY_VARIABLES.some((name) => env[name])) return { fetch: globalThis.fetch };
    const signature = [...PROXY_VARIABLES, 'NO_PROXY', 'no_proxy'].map((name) => env[name] ?? '').join('\n');
    if (proxyTransport?.signature !== signature) {
        proxyTransport = {
            signature,
            transport: import('undici').then((undici) => ({ fetch: undici.fetch as unknown as typeof fetch, dispatcher: new undici.EnvHttpProxyAgent() })),
        };
    }
    return proxyTransport.transport;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
    query?: Query;
    body?: unknown;
    anonymous?: boolean;
    /** Per-attempt timeout for this call (SUTRAMX_TIMEOUT still wins). */
    timeoutMs?: number;
    /** Idempotency-Key for a POST; one is generated when left out. */
    idempotencyKey?: string;
}

export class SutramXApi {
    readonly baseUrl: string;

    /** Delay between retries; tests set it to 0. */
    retryDelay: (attempt: number, retryAfter: string | null) => number = retryDelayMs;

    /** Where retry notes go (stderr, so stdout stays machine-readable). */
    notify: (message: string) => void = (message) => { process.stderr.write(`${message}\n`); };

    /** Largest response body accepted. */
    maxResponseBytes = MAX_RESPONSE_BYTES;

    constructor(private readonly apiKey: string, baseUrl: string = DEFAULT_API_URL) {
        this.baseUrl = validateApiUrl(baseUrl);
        if (apiKey && !isTrustedApiHost(this.baseUrl)) {
            warnOnce(`sending your SutramX API key to ${new URL(this.baseUrl).host}, which is not a sutramx.com host. Check SUTRAMX_API_URL / --api-url.`);
        }
        if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
            warnOnce('NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate checks; your API key can be intercepted.');
        }
    }

    async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query || {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const host = url.host;
        const headers: Record<string, string> = {
            Accept: 'application/json', 'User-Agent': `sutramx-cli/${VERSION}`, 'X-SutramX-Client': `sutramx-cli/${VERSION}`,
        };
        if (!options.anonymous) headers.Authorization = `Bearer ${this.apiKey}`;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        // One key per logical POST, reused by every retry of it: the API then
        // runs it once (older APIs ignore the header).
        const idempotencyKey = method === 'POST' ? (options.idempotencyKey ?? randomUUID()) : undefined;
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        // Retries: 429 for any method (the request was refused, not run);
        // 502/503/504, timeouts and network errors for idempotent methods and
        // for POSTs that carry an Idempotency-Key.
        const retrySafe = method === 'GET' || method === 'PUT' || method === 'DELETE' || idempotencyKey !== undefined;
        const perAttempt = timeoutFromEnv() ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + perAttempt * DEADLINE_ATTEMPTS;
        const { fetch: fetchImpl, dispatcher } = await transport();
        const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
        const label = `${method} ${url.pathname}`;

        /** Delay before the next attempt, or null when out of attempts or time (or Retry-After is too long to wait). */
        const nextDelay = (attempt: number, retryAfter: string | null): number | null => {
            if (attempt >= MAX_ATTEMPTS - 1) return null;
            const delay = Math.max(0, this.retryDelay(attempt, retryAfter));
            return delay > MAX_RETRY_DELAY_MS || Date.now() + delay >= deadline ? null : delay;
        };
        const wait = async (delay: number, attempt: number, reason: string) => {
            this.notify(`Retrying ${label} in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 2} of ${MAX_ATTEMPTS}): ${reason}`);
            await sleep(delay);
        };

        let response: Response;
        let text: string | undefined;
        let inProgressWaits = 0;
        for (let attempt = 0; ; attempt += 1) {
            const attemptTimeout = Math.max(1, Math.min(perAttempt, deadline - Date.now()));
            try {
                response = await fetchImpl(url, {
                    method,
                    headers,
                    body: payload,
                    signal: AbortSignal.timeout(attemptTimeout),
                    // Never follow redirects: the API does not redirect, and a
                    // redirect must not carry the key to another place.
                    redirect: 'error',
                    ...(dispatcher ? { dispatcher } : {}),
                } as RequestInit);
            } catch (error) {
                const failure = networkError(error, host, Math.min(perAttempt, attemptTimeout + 50));
                const delay = retrySafe && retryableNetworkError(failure) ? nextDelay(attempt, null) : null;
                if (delay === null) throw failure;
                await wait(delay, attempt, failure.causeCode || 'network error');
                continue;
            }
            text = undefined;
            const status = response.status;
            // The same POST is still running on the server: wait, then ask again with the same key.
            if (status === 409 && idempotencyKey) {
                text = await this.read(response, host);
                if (errorCodeOf(text) === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' && inProgressWaits < 30) {
                    inProgressWaits += 1;
                    const delay = Math.min(Math.max(0, this.retryDelay(0, response.headers.get('retry-after') ?? '1')), MAX_RETRY_DELAY_MS);
                    if (Date.now() + delay < deadline) {
                        this.notify(`${label} is still running on the server; checking again in ${(delay / 1000).toFixed(1)}s`);
                        await sleep(delay);
                        attempt -= 1; // not a failed attempt
                        continue;
                    }
                }
            }
            if (status === 429 || (retrySafe && [502, 503, 504].includes(status))) {
                text = await this.read(response, host);
                // A plan limit can come as 429 (AI drafts): waiting does not help.
                const planLimit = isPlanLimit(parseErrorBody(status, parseJson(text)));
                const delay = planLimit ? null : nextDelay(attempt, response.headers.get('retry-after'));
                if (delay !== null) {
                    await wait(delay, attempt, `HTTP ${status}`);
                    continue;
                }
            }
            break;
        }
        if (response.status === 204 || response.status === 205) return undefined as T;
        if (text === undefined) text = await this.read(response, host);
        if (!response.ok) {
            const error = parseErrorBody(response.status, parseJson(text));
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            if (retryAfter !== null) error.retryAfterMs = retryAfter;
            throw error;
        }
        // 207: a declarative apply that partly failed still carries results.
        if (!text.trim()) return undefined as T;
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            const type = response.headers.get('content-type') || 'no content type';
            throw new ApiError(response.status, `Expected JSON from ${host} but got ${oneLine(type, 60)} ("${oneLine(text, 80)}"). A proxy, captive portal or a wrong --api-url / SUTRAMX_API_URL can cause this`, 'INVALID_RESPONSE');
        }
        if (method !== 'GET' && body && typeof body === 'object' && Array.isArray((body as { warnings?: unknown; }).warnings)) {
            for (const warning of (body as { warnings: unknown[]; }).warnings) process.stderr.write(`Warning: ${oneLine(String(warning), 500)}\n`);
        }
        return body as T;
    }

    private async read(response: Response, host: string): Promise<string> {
        try {
            return await readBody(response, this.maxResponseBytes, host);
        } catch (error) {
            if (error instanceof ApiError) throw error;
            throw networkError(error, host, 0);
        }
    }

    get<T>(path: string, query?: Query) { return this.request<T>('GET', path, { query }); }
    getPublic<T>(path: string, query?: Query) { return this.request<T>('GET', path, { query, anonymous: true }); }
    post<T>(path: string, body: unknown = {}, options: Omit<RequestOptions, 'body' | 'query'> = {}) { return this.request<T>('POST', path, { ...options, body }); }
    put<T>(path: string, body: unknown = {}) { return this.request<T>('PUT', path, { body }); }
    patch<T>(path: string, body: unknown = {}) { return this.request<T>('PATCH', path, { body }); }
    delete<T>(path: string) { return this.request<T>('DELETE', path); }
}

function networkHint(error: NetworkError): string {
    const code = error.causeCode;
    if (error.timedOut) return 'The API did not answer in time. Retry, or allow more time with SUTRAMX_TIMEOUT=<seconds>.';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The host name ${error.host} could not be resolved: check --api-url / SUTRAMX_API_URL, DNS and your network.`;
    if (code === 'ECONNREFUSED') return `Nothing accepted the connection at ${error.host}: check --api-url / SUTRAMX_API_URL, or HTTPS_PROXY if you use a proxy.`;
    if (isTlsCode(code)) return 'The TLS certificate could not be verified. Behind a TLS-inspecting proxy, point NODE_EXTRA_CA_CERTS at its CA certificate.';
    if (/redirect/i.test(error.message)) return 'The API URL answered with a redirect, which is never followed: check --api-url / SUTRAMX_API_URL.';
    return 'Check your network connection (and HTTPS_PROXY / NO_PROXY if you use a proxy).';
}

/** One-line explanation with a hint for common failures. */
export function describeError(error: unknown): string {
    if (!(error instanceof ApiError)) return (error as Error)?.message || String(error);
    if (error instanceof NetworkError) return `${error.message}\n${networkHint(error)}`;
    const code = error.code ? ` ${error.code}` : '';
    let hint = '';
    if (error.status === 401) hint = 'Run `sutramx login` or set SUTRAMX_API_KEY.';
    else if (error.code === 'AUTOMATION_KEY_REQUIRED') hint = 'Managing integrations needs an API key with the "Automation" access level.';
    else if (isPlanLimit(error)) hint = 'Your plan does not allow this, so retrying will not help; see `sutramx whoami` for the limits, or upgrade the plan.';
    else if (error.status === 429) {
        hint = error.retryAfterMs !== undefined ? `Rate limited; retry in ${Math.ceil(error.retryAfterMs / 1000)}s.` : 'Rate limited; wait a few minutes.';
    }
    let detail = '';
    const specs = (error.details as { specs?: Array<{ key: string | null; index: number; errors: string[]; }>; } | undefined)?.specs;
    if (Array.isArray(specs)) {
        detail = specs.map((spec) => `\n  monitor ${spec.key ?? `#${spec.index + 1}`}: ${spec.errors.join('; ')}`).join('');
    }
    return `${error.message} (HTTP ${error.status}${code})${detail}${hint ? `\n${hint}` : ''}`;
}
