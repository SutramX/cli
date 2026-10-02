import { VERSION } from './version.js';

export const DEFAULT_API_URL = 'https://api.sutramx.com';
const REQUEST_TIMEOUT_MS = 60_000;

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
            return new ApiError(status, fieldErrors ? `${record.error}: ${fieldErrors}` : record.error, record.code ? String(record.code) : undefined, record.errors ?? record);
        }
    }
    return new ApiError(status, `HTTP ${status}`);
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class SutramXApi {
    readonly baseUrl: string;

    constructor(private readonly apiKey: string, baseUrl: string = DEFAULT_API_URL) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    async request<T>(method: string, path: string, options: { query?: Query; body?: unknown; anonymous?: boolean; } = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query || {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `sutramx-cli/${VERSION}` };
        if (!options.anonymous) headers.Authorization = `Bearer ${this.apiKey}`;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            throw new ApiError(0, `Could not reach ${this.baseUrl}: ${(error as Error).message}`);
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
