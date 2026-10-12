import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { EXIT } from '../src/api.js';

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

test('CM-5: distinct exit codes for auth, not found, rate limit, network, plan limit and usage', async () => {
    const { url } = await serve((req, res) => {
        if (req.url === '/automation/whoami') return json(res, 401, { error: 'Invalid API key', code: 'API_KEY_INVALID' });
        if (req.url!.startsWith('/automation/monitors/')) return json(res, 404, { error: 'Monitor not found' });
        if (req.url === '/monitors' && req.method === 'POST') return json(res, 403, { error: 'Monitor limit reached', code: 'MONITOR_TOTAL_LIMIT_REACHED' });
        if (req.url === '/monitors') return json(res, 429, { error: 'Too many requests', code: 'RATE_LIMITED' }, { 'Retry-After': '900' });
        json(res, 500, { error: 'boom' });
    });
    const port = await closedPort();
    const cases: Array<[string[], NodeJS.ProcessEnv, number]> = [
        [['whoami'], { SUTRAMX_API_URL: url }, EXIT.AUTH],
        [['monitors', 'get', 'missing-key'], { SUTRAMX_API_URL: url }, EXIT.NOT_FOUND],
        [['monitors', 'list'], { SUTRAMX_API_URL: url }, EXIT.RATE_LIMITED],
        [['monitors', 'create', '--name', 'x', '--url', 'https://example.com'], { SUTRAMX_API_URL: url }, EXIT.PLAN_LIMIT],
        [['whoami'], { SUTRAMX_API_URL: `http://127.0.0.1:${port}` }, EXIT.NETWORK],
        [['monitors', 'create'], { SUTRAMX_API_URL: url }, EXIT.USAGE],
        [['whoami'], { SUTRAMX_API_KEY: undefined, SUTRAMX_API_URL: url }, EXIT.AUTH],
    ];
    for (const [args, env, code] of cases) {
        const result = await sutramx(args, env);
        assert.equal(result.code, code, `sutramx ${args.join(' ')}: ${result.stderr}`);
    }
    const limited = await sutramx(['monitors', 'list'], { SUTRAMX_API_URL: url });
    assert.match(limited.stderr, /retry in 900s/);
    const plan = await sutramx(['monitors', 'create', '--name', 'x', '--url', 'https://example.com'], { SUTRAMX_API_URL: url });
    assert.match(plan.stderr, /retrying will not help/);
    assert.ok(Object.values(EXIT).length === new Set(Object.values(EXIT)).size);
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const code of Object.values(EXIT)) assert.match(readme, new RegExp(`\\| \`${code}\` \\|`), `README exit code table misses ${code}`);
});

test('interactive prompts write to stderr, never stdout', () => {
    const source = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    assert.match(source, /readSecretFrom\(prompt, stdin, process\.stderr\)/);
    assert.match(source, /createInterface\(\{ input: stdin, output: process\.stderr \}\)/);
    assert.doesNotMatch(source, /createInterface\(\{[^}]*output: stdout/);
});
