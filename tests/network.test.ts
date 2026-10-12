import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { ApiError, describeError, EXIT, exitCodeForApiError, isIdempotentPostRoute, isPlanLimit, NetworkError, parseRetryAfter, SutramXApi } from '../src/api.js';
import { VERSION } from '../src/version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen, index: number) => void;

const servers: http.Server[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const name of ['SUTRAMX_TIMEOUT', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[name];
});

async function serve(handler: Handler): Promise<{ url: string; seen: Seen[]; port: number; }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const entry = { method: req.method!, url: req.url!, headers: req.headers, body };
            seen.push(entry);
            handler(req, res, entry, seen.length - 1);
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}`, seen, port };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

function client(url: string, notes: string[] = []): SutramXApi {
    const api = new SutramXApi('sk_test', url);
    api.retryDelay = () => 0;
    api.notify = (message) => { notes.push(message); };
    return api;
}

/** A free port with nothing listening on it. */
async function closedPort(): Promise<number> {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

function sutramx(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string; }> {
    const full: NodeJS.ProcessEnv = {
        ...process.env, SUTRAMX_API_KEY: 'sk_test', NO_COLOR: '1',
        SUTRAMX_CONFIG: join(mkdtempSync(join(tmpdir(), 'sutramx-net-')), 'credentials.json'), ...env,
    };
    for (const [key, value] of Object.entries(full)) if (value === undefined) delete full[key];
    return new Promise((resolve) => {
        const child = execFile(process.execPath, ['--import', 'tsx', join(ROOT, 'src/index.ts'), ...args], { cwd: ROOT, env: full }, (error, stdout, stderr) => {
            resolve({ code: error ? Number((error as { code?: number; }).code ?? 1) : 0, stdout, stderr });
        });
        child.stdin!.end('');
    });
}

test('M1: every POST carries an Idempotency-Key, reused by its retries (503, then success); client headers are sent', async () => {
    const notes: string[] = [];
    const { url, seen } = await serve((_req, res, _seen, index) => (index === 0 ? json(res, 503, { error: 'busy' }) : json(res, 201, { id: 'm1' })));
    const api = client(url, notes);
    assert.deepEqual(await api.post('/monitors', { name: 'x' }), { id: 'm1' });
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    assert.match(String(first.headers['idempotency-key']), /^[0-9a-f-]{36}$/);
    assert.equal(second.headers['idempotency-key'], first.headers['idempotency-key']);
    assert.equal(first.headers['x-sutramx-client'], `sutramx-cli/${VERSION}`);
    assert.equal(first.headers['user-agent'], `sutramx-cli/${VERSION}`);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Retrying POST \/monitors .*attempt 2 of 4.*HTTP 503/);

    // A new logical create gets a new key; GET/PATCH carry none.
    await api.post('/monitors', { name: 'y' });
    assert.notEqual(seen[2].headers['idempotency-key'], first.headers['idempotency-key']);
    await api.get('/monitors');
    assert.equal(seen[3].headers['idempotency-key'], undefined);
});

test('M1: a POST is retried with the same key after the connection drops; PATCH (no key) is not', async () => {
    const { url, seen } = await serve((req, res, _seen, index) => {
        if (index === 0 || req.method === 'PATCH') return req.socket.destroy();
        json(res, 201, { ok: true });
    });
    const api = client(url);
    assert.deepEqual(await api.post('/monitors', {}), { ok: true });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].headers['idempotency-key'], seen[1].headers['idempotency-key']);
    await assert.rejects(api.patch('/monitors/1', {}), (error: unknown) => error instanceof NetworkError);
    assert.equal(seen.filter((entry) => entry.method === 'PATCH').length, 1);
});

test('M1: 409 IDEMPOTENCY_REQUEST_IN_PROGRESS waits (Retry-After) and asks again with the same key', async () => {
    const delays: Array<string | null> = [];
    const { url, seen } = await serve((_req, res, _seen, index) => {
        if (index < 2) return json(res, 409, { error: 'still running', code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' }, { 'Retry-After': '1' });
        json(res, 201, { id: 'm1' }, { 'Idempotent-Replayed': 'true' });
    });
    const api = client(url);
    api.retryDelay = (_attempt, retryAfter) => { delays.push(retryAfter); return 0; };
    assert.deepEqual(await api.post('/monitors', {}), { id: 'm1' });
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen.map((entry) => entry.headers['idempotency-key'])).size, 1);
    assert.deepEqual(delays, ['1', '1']);

    // Any other 409 is an error, not retried.
    const other = await serve((_req, res) => json(res, 409, { error: 'The plan changed', code: 'PLAN_CHANGED' }));
    await assert.rejects(client(other.url).post('/automation/monitors/apply', {}), (error: unknown) => error instanceof ApiError && error.code === 'PLAN_CHANGED');
    assert.equal(other.seen.length, 1);
});

test('only the POST routes the API dedupes are retried; acknowledge, resolve, run-check, pause, test ... are sent once', async () => {
    for (const path of ['/monitors', '/v1/monitors', '/monitors/', '/monitors?x=1', '/monitors/bulk', '/monitors/detect/apply', '/monitor-groups', '/status/pages',
        '/status/pages/p1/monitors', '/integrations/slack/connections', '/integrations/slack/connect', '/incidents', '/incidents/runbooks',
        '/incidents/i1/notes', '/maintenance', '/automation/monitors/apply', '/api/v1/maintenance']) {
        assert.ok(isIdempotentPostRoute(path), path);
    }
    for (const path of ['/incidents/i1/acknowledge', '/incidents/i1/resolve', '/monitors/m1/run-check', '/monitors/m1/pause', '/monitors/m1/resume',
        '/integrations/slack/connections/c1/test', '/monitors/m1/heartbeat/rotate-secret', '/automation/monitors/plan', '/monitors/m1', '/ai']) {
        assert.ok(!isIdempotentPostRoute(path), path);
    }

    // 503: a non-deduped POST is attempted once; POST /monitors is retried with the same key.
    const busy = await serve((_req, res, _seen, index) => (index === 0 ? json(res, 503, { error: 'busy' }) : json(res, 201, { ok: true })));
    await assert.rejects(client(busy.url).post('/incidents/i1/resolve', {}), (error: unknown) => error instanceof ApiError && error.status === 503);
    assert.equal(busy.seen.length, 1);
    const unavailable = await serve((_req, res) => json(res, 503, { error: 'busy' }));
    for (const path of ['/incidents/i1/acknowledge', '/monitors/m1/run-check', '/monitors/m1/pause', '/integrations/slack/connections/c1/test']) {
        await assert.rejects(client(unavailable.url).post(path, {}), (error: unknown) => error instanceof ApiError && error.status === 503);
    }
    assert.equal(unavailable.seen.length, 4);

    // 429 and a dropped connection: the action is not repeated either.
    const limited = await serve((_req, res) => json(res, 429, { error: 'slow down' }, { 'Retry-After': '0' }));
    await assert.rejects(client(limited.url).post('/monitors/m1/run-check', {}), (error: unknown) => error instanceof ApiError && error.status === 429);
    assert.equal(limited.seen.length, 1);
    const dropped = await serve((req) => req.socket.destroy());
    await assert.rejects(client(dropped.url).post('/incidents/i1/acknowledge', {}), (error: unknown) => error instanceof NetworkError);
    assert.equal(dropped.seen.length, 1);

    // A base URL with a path prefix: the route is matched after it.
    const prefixed = await serve((_req, res, _seen, index) => (index === 0 ? json(res, 503, { error: 'busy' }) : json(res, 201, { id: 'm1' })));
    assert.deepEqual(await client(`${prefixed.url}/api/v1`).post('/monitors', {}), { id: 'm1' });
    assert.equal(prefixed.seen.length, 2);
    assert.equal(prefixed.seen[0].url, '/api/v1/monitors');
    assert.equal(prefixed.seen[1].headers['idempotency-key'], prefixed.seen[0].headers['idempotency-key']);
});

test('a non-deduped POST that times out is attempted once; 409 IDEMPOTENT_RESPONSE_WITHHELD is an error, not retried', async () => {
    process.env.SUTRAMX_TIMEOUT = '0.3';
    const slow = await serve((_req, res) => { setTimeout(() => json(res, 200, {}), 1000); });
    await assert.rejects(client(slow.url).post('/monitors/m1/run-check', {}), (error: unknown) => error instanceof NetworkError && error.timedOut);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(slow.seen.length, 1);
    delete process.env.SUTRAMX_TIMEOUT;

    const withheld = await serve((_req, res) => json(res, 409, { error: 'The original response held a secret', code: 'IDEMPOTENT_RESPONSE_WITHHELD' }));
    await assert.rejects(client(withheld.url).post('/monitors', {}), (error: unknown) => error instanceof ApiError && error.code === 'IDEMPOTENT_RESPONSE_WITHHELD');
    assert.equal(withheld.seen.length, 1);

    // IN_PROGRESS on a route the API does not dedupe is not waited on.
    const inProgress = await serve((_req, res) => json(res, 409, { error: 'running', code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' }, { 'Retry-After': '1' }));
    await assert.rejects(client(inProgress.url).post('/incidents/i1/resolve', {}), (error: unknown) => error instanceof ApiError && error.status === 409);
    assert.equal(inProgress.seen.length, 1);
});

test('CM-2: per-attempt timeout from SUTRAMX_TIMEOUT; a timed-out POST is retried with its key; the overall deadline stops it', async () => {
    process.env.SUTRAMX_TIMEOUT = '0.3';
    const notes: string[] = [];
    const { url, seen } = await serve((_req, res, _seen, index) => {
        if (index === 0) return setTimeout(() => json(res, 201, { late: true }), 1000);
        json(res, 201, { id: 'm1' });
    });
    assert.deepEqual(await client(url, notes).post('/monitors', {}), { id: 'm1' });
    assert.equal(seen[0].headers['idempotency-key'], seen[1].headers['idempotency-key']);
    assert.match(notes[0], /ETIMEDOUT/);

    const slow = await serve((_req, res) => { setTimeout(() => json(res, 200, {}), 2000); });
    const started = Date.now();
    await assert.rejects(client(slow.url).get('/monitors'), (error: unknown) => error instanceof NetworkError && error.timedOut && /ETIMEDOUT/.test(error.message) && /0\.3s/.test(error.message));
    assert.ok(Date.now() - started < 1500, `deadline not honoured: ${Date.now() - started}ms`);
    assert.ok(slow.seen.length >= 2 && slow.seen.length <= 3, `attempts: ${slow.seen.length}`);
});

test('CM-1: a 2xx body that is not JSON is an error (and a non-zero exit, with and without --json)', async () => {
    const { url } = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Please log in to the Wi-Fi</body></html>');
    });
    await assert.rejects(client(url).get('/automation/whoami'), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE' && /text\/html/.test(error.message));
    for (const args of [['whoami'], ['whoami', '--json'], ['monitors', 'list', '--json']]) {
        const result = await sutramx(args, { SUTRAMX_API_URL: url });
        assert.equal(result.code, EXIT.ERROR, `${args.join(' ')}: ${result.stderr}`);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Expected JSON/);
    }
});

/** A CONNECT proxy (what undici's proxy agent speaks) that records the targets it tunnels to. */
async function connectProxy(): Promise<{ url: string; targets: string[]; }> {
    const targets: string[] = [];
    const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
        targets.push(req.url!);
        const [host, port] = req.url!.split(':');
        const upstream = connect(Number(port), host, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, targets };
}

test('CM-3: HTTP_PROXY routes requests through the proxy; NO_PROXY bypasses it', async () => {
    const api = await serve((_req, res) => json(res, 200, { ok: true }));
    const proxy = await connectProxy();
    const target = api.url.replace('http://', '');
    process.env.HTTP_PROXY = proxy.url;
    assert.deepEqual(await client(api.url).get('/monitors'), { ok: true });
    assert.deepEqual(proxy.targets, [target]);
    assert.equal(api.seen[0].headers.authorization, 'Bearer sk_test');
    process.env.NO_PROXY = '127.0.0.1';
    assert.deepEqual(await client(api.url).get('/monitors'), { ok: true });
    assert.equal(proxy.targets.length, 1, 'NO_PROXY host went through the proxy');
    assert.equal(api.seen.length, 2);

    // And from the command line.
    const cli = await sutramx(['whoami', '--json'], { SUTRAMX_API_URL: api.url, HTTP_PROXY: proxy.url, NO_PROXY: undefined, no_proxy: undefined });
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(proxy.targets.length, 2);
});

test('CM-4: network errors name the cause code and host, never "HTTP 0"', async () => {
    const port = await closedPort();
    const refused = await client(`http://127.0.0.1:${port}`).get('/monitors').catch((error) => error);
    assert.ok(refused instanceof NetworkError);
    assert.equal(refused.causeCode, 'ECONNREFUSED');
    const text = describeError(refused);
    assert.match(text, new RegExp(`Could not reach 127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)`));
    assert.doesNotMatch(text, /HTTP 0/);

    const realFetch = globalThis.fetch;
    try {
        globalThis.fetch = (async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }); }) as typeof fetch;
        let calls = 0;
        const counting = globalThis.fetch;
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { calls += 1; return counting(...args); }) as typeof fetch;
        const tls = await client('https://api.sutramx.com').get('/monitors').catch((error) => error);
        assert.ok(tls instanceof NetworkError);
        assert.equal(calls, 1, 'TLS failures are not retried');
        assert.match(describeError(tls), /api\.sutramx\.com \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/);
        assert.match(describeError(tls), /NODE_EXTRA_CA_CERTS/);

        globalThis.fetch = (async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.sutramx.example'), { code: 'ENOTFOUND' }) }); }) as typeof fetch;
        const dns: ApiError = await client('https://api.sutramx.com').get<never>('/monitors').catch((error: ApiError) => error);
        assert.match(describeError(dns), /\(ENOTFOUND\)/);
        assert.equal(exitCodeForApiError(dns), EXIT.NETWORK);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('Retry-After: delta-seconds and HTTP-date; a 429 with an HTTP-date is retried after it', async () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    assert.equal(parseRetryAfter('120', now), 120_000);
    assert.equal(parseRetryAfter('0', now), 0);
    assert.equal(parseRetryAfter('Mon, 12 Oct 2026 10:00:30 GMT', now), 30_000);
    assert.equal(parseRetryAfter('Mon, 12 Oct 2026 09:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter('soon', now), null);
    assert.equal(parseRetryAfter(null, now), null);

    const { url, seen } = await serve((_req, res, _seen, index) => {
        if (index === 0) return json(res, 429, { error: 'slow down' }, { 'Retry-After': new Date(Date.now() + 1000).toUTCString() });
        json(res, 200, { ok: true });
    });
    const api = new SutramXApi('sk_test', url);
    api.notify = () => undefined;
    const started = Date.now();
    assert.deepEqual(await api.get('/monitors'), { ok: true });
    assert.equal(seen.length, 2);
    assert.ok(Date.now() - started >= 200, 'waited for the HTTP-date');
});

test('a long Retry-After is reported, not slept through; plain-text 429 bodies are readable', async () => {
    const { url, seen } = await serve((_req, res) => {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '600' });
        res.end('Too many requests, please try again later.');
    });
    const api = new SutramXApi('sk_test', url);
    const error = await api.get('/monitors').catch((caught) => caught);
    assert.equal(seen.length, 1);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryAfterMs, 600_000);
    assert.match(describeError(error), /Too many requests, please try again later\. \(HTTP 429 RATE_LIMITED\)\nRate limited; retry in 600s/);
});

test('plan limits: every code and category PLAN_LIMIT; a 429 plan limit (AI drafts) is not retried', async () => {
    for (const code of ['ENTITLEMENT_LIMIT_REACHED', 'ENTITLEMENT_INTERVAL_TOO_SHORT', 'MONITOR_TOTAL_LIMIT_REACHED', 'CONNECTION_LIMIT_REACHED', 'LIMIT_REACHED', 'AI_LIMIT_REACHED', 'FEATURE_NOT_AVAILABLE']) {
        const error = new ApiError(403, 'no', code);
        assert.ok(isPlanLimit(error), code);
        assert.equal(exitCodeForApiError(error), EXIT.PLAN_LIMIT);
    }
    const { url, seen } = await serve((req, res) => {
        if (req.url === '/ai') return json(res, 429, { error: 'You have used all AI drafts', code: 'AI_LIMIT_REACHED' });
        json(res, 403, { error: 'Upgrade needed', code: 'SOMETHING_NEW', category: 'PLAN_LIMIT', details: { resource: 'monitors' } });
    });
    const api = client(url);
    const ai = await api.post('/ai', {}).catch((error) => error);
    assert.equal(seen.length, 1);
    assert.ok(isPlanLimit(ai));
    const categorised = await api.post('/monitors', {}).catch((error) => error);
    assert.ok(isPlanLimit(categorised));
    assert.match(describeError(categorised), /plan does not allow this/);
});

test('warnings in write responses go to stderr; stdout keeps the JSON', async () => {
    const { url } = await serve((_req, res) => json(res, 201, { id: '11111111-1111-4111-8111-111111111111', name: 'x', warnings: ['Ignored unknown field: foo\u001b[2J'] }));
    const result = await sutramx(['monitors', 'create', '--name', 'x', '--url', 'https://example.com', '--json'], { SUTRAMX_API_URL: url });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).monitor.name, 'x');
    assert.match(result.stderr, /Warning: Ignored unknown field: foo/);
    assert.doesNotMatch(result.stderr, /\u001b/);
});

test('responses over the size cap are refused with a clear error', async () => {
    const big = 'x'.repeat(4096);
    const declared = await serve((_req, res) => json(res, 200, { big }));
    const api = client(declared.url);
    api.maxResponseBytes = 1024;
    await assert.rejects(api.get('/monitors'), (error: unknown) => error instanceof ApiError && error.code === 'RESPONSE_TOO_LARGE' && /larger than/.test(error.message));
    const streamed = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); // chunked, no Content-Length
        res.write(`{"big":"${big}`);
        res.end('"}');
    });
    const streamedApi = client(streamed.url);
    streamedApi.maxResponseBytes = 1024;
    await assert.rejects(streamedApi.get('/monitors'), (error: unknown) => error instanceof ApiError && error.code === 'RESPONSE_TOO_LARGE');
});
