import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';

/**
 * End to end: the CLI from source against a fake API on loopback, never a
 * terminal (stdin is not a TTY), so confirmation prompts are refused.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEPT = { id: '11111111-1111-4111-8111-111111111111', external_id: 'homepage', name: 'Homepage' };
const ORPHAN = { id: '22222222-2222-4222-8222-222222222222', external_id: 'old', name: 'Old' };

let calls: Array<{ method: string; url: string; body?: any; }> = [];
let fingerprint: string | undefined;
let planDeletes = true;
let applyStatus = 200;
let server: http.Server;
let baseUrl = '';

before(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : undefined;
            calls.push({ method: req.method!, url: req.url!, body });
            const send = (status: number, payload: unknown) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            const route = `${req.method} ${req.url}`;
            if (route === 'POST /automation/monitors/plan') {
                const changes = [
                    { action: 'create', key: 'api', name: 'API', type: 'http', monitor_id: null, changes: [] },
                    ...(body.prune && planDeletes ? [{ action: 'delete', key: ORPHAN.external_id, name: ORPHAN.name, type: 'http', monitor_id: ORPHAN.id, changes: [] }] : []),
                ];
                return send(200, { changes, summary: {}, ...(fingerprint ? { plan_fingerprint: fingerprint } : {}) });
            }
            if (route === 'POST /automation/monitors/apply') {
                if (applyStatus === 409) return send(409, { error: 'The plan changed', code: 'PLAN_CHANGED' });
                return send(200, { ok: true, results: [{ action: 'create', key: 'api', name: 'API', type: 'http', monitor_id: '33333333-3333-4333-8333-333333333333', changes: [], status: 'applied' }] });
            }
            if (route === 'GET /monitors') return send(200, [KEPT, ORPHAN]);
            if (route === `GET /monitors/${KEPT.id}`) return send(200, KEPT);
            if (route === 'GET /automation/whoami') return send(200, { workspace_id: 'ws_1', plan: 'pro', api_key_access: 'standard', can_manage_alert_channels: true });
            send(404, { error: 'Not found' });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
    calls = [];
    fingerprint = undefined;
    planDeletes = true;
    applyStatus = 200;
});

function manifest(extra = ''): string {
    const dir = mkdtempSync(join(tmpdir(), 'sutramx-apply-'));
    const file = join(dir, 'sutramx.yml');
    writeFileSync(file, `${extra}monitors:\n  - key: homepage\n    name: Homepage\n    url: https://example.com\n  - key: api\n    name: API\n    url: https://api.example.com\n`);
    return file;
}

function sutramx(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; } = {}): Promise<{ code: number; stdout: string; stderr: string; }> {
    const env: NodeJS.ProcessEnv = {
        ...process.env, SUTRAMX_API_KEY: 'sk_test', SUTRAMX_API_URL: baseUrl, NO_COLOR: '1',
        SUTRAMX_CONFIG: join(mkdtempSync(join(tmpdir(), 'sutramx-cfg-')), 'credentials.json'), ...options.env,
    };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    return new Promise((resolve) => {
        const child = execFile(process.execPath, ['--import', 'tsx', join(ROOT, 'src/index.ts'), ...args], { cwd: ROOT, env }, (error, stdout, stderr) => {
            resolve({ code: error ? Number((error as { code?: number; }).code ?? 1) : 0, stdout, stderr });
        });
        child.stdin!.end(options.input ?? '');
    });
}

const applyCalls = () => calls.filter((call) => call.url === '/automation/monitors/apply');

test('apply sends the fingerprint of the plan it showed', async () => {
    fingerprint = 'fp_abc123';
    const result = await sutramx(['apply', '-f', manifest(), '--prune', '--auto-approve']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /delete/);
    const [apply] = applyCalls();
    assert.equal(apply.body.expected_fingerprint, 'fp_abc123');
    assert.equal(apply.body.prune, true);
    assert.equal(apply.body.allow_prune_without_fingerprint, undefined);
});

test('a changed plan (409 PLAN_CHANGED) tells the user to re-run', async () => {
    fingerprint = 'fp_old';
    applyStatus = 409;
    const result = await sutramx(['apply', '-f', manifest(), '--auto-approve']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /changed since the plan was shown, so nothing was applied\. Run `sutramx apply` again/);
});

test('older API without fingerprints: prune deletes are refused unless forced', async () => {
    const refused = await sutramx(['apply', '-f', manifest(), '--prune', '--auto-approve']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /cannot verify .*--force-prune-without-plan-check/);
    assert.equal(applyCalls().length, 0);

    const forced = await sutramx(['apply', '-f', manifest(), '--prune', '--auto-approve', '--force-prune-without-plan-check']);
    assert.equal(forced.code, 0, forced.stderr);
    const [apply] = applyCalls();
    assert.equal(apply.body.prune, true);
    assert.equal(apply.body.allow_prune_without_fingerprint, true);
    assert.equal(apply.body.expected_fingerprint, undefined);
});

test('older API without fingerprints: a prune that showed no deletes is applied without prune', async () => {
    planDeletes = false;
    const result = await sutramx(['apply', '-f', manifest(), '--prune', '--auto-approve']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(applyCalls()[0].body.prune, false);
});

test('settings.prune in the file never deletes without --prune', async () => {
    fingerprint = 'fp_1';
    const result = await sutramx(['apply', '-f', manifest('settings: { prune: true }\n'), '--auto-approve']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /settings\.prune is set in the file, but monitors are only deleted with --prune/);
    assert.equal(calls.find((call) => call.url === '/automation/monitors/plan')!.body.prune, false);
    assert.equal(applyCalls()[0].body.prune, false);
});

test('apply without a terminal needs --auto-approve or --yes', async () => {
    const refused = await sutramx(['apply', '-f', manifest()]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Refusing to apply without confirmation/);
    assert.equal(applyCalls().length, 0);
    const yes = await sutramx(['apply', '-f', manifest(), '--yes']);
    assert.equal(yes.code, 0, yes.stderr);
});

test('monitors delete and public incident notes need confirmation (or --yes)', async () => {
    const del = await sutramx(['monitors', 'delete', KEPT.id]);
    assert.equal(del.code, 1);
    assert.match(del.stderr, /Not deleted/);
    const note = await sutramx(['incidents', 'note', '44444444-4444-4444-8444-444444444444', 'We are back', '--public']);
    assert.equal(note.code, 1);
    assert.match(note.stderr, /Not published/);
    assert.ok(!calls.some((call) => call.method === 'DELETE' || call.url.endsWith('/notes')));
});

test('login saves the key 0600, never prints it, and saves the API URL only when --api-url is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sutramx-login-'));
    const path = join(dir, 'credentials.json');
    const fromEnv = await sutramx(['login'], { env: { SUTRAMX_API_KEY: undefined, SUTRAMX_CONFIG: path }, input: 'sk_secret_value\n' });
    assert.equal(fromEnv.code, 0, fromEnv.stderr);
    assert.doesNotMatch(fromEnv.stdout + fromEnv.stderr, /sk_secret_value/);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.api_key, 'sk_secret_value');
    assert.equal(saved.api_url, undefined, 'SUTRAMX_API_URL from the environment must not be persisted');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);

    const explicit = await sutramx(['--api-url', baseUrl, 'login'], { env: { SUTRAMX_API_KEY: undefined, SUTRAMX_API_URL: undefined, SUTRAMX_CONFIG: path }, input: 'sk_secret_value\n' });
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).api_url, baseUrl);
});

test('a plain-http API URL that is not loopback is refused before the key is sent', async () => {
    const result = await sutramx(['whoami'], { env: { SUTRAMX_API_URL: 'http://api.example.com' } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /https/);
    assert.equal(calls.length, 0);
});
