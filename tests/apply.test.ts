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
let planReplace = false;
let applyStatus = 200;
let echoPlan: 'none' | 'change' | 'error' = 'none';
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
                // Echo what the CLI sent, as a plan change (stdout) or a validation error (stderr).
                if (echoPlan === 'error') return send(422, { error: `Invalid monitor: ${JSON.stringify(body.monitors)}` });
                if (echoPlan === 'change') {
                    const [first] = body.monitors;
                    return send(200, { changes: [{ action: 'create', key: first.key, name: first.name, type: 'http', monitor_id: null, changes: [{ field: 'url', from: null, to: first.url }] }], summary: {} });
                }
                const changes = [
                    { action: 'create', key: 'api', name: 'API', type: 'http', monitor_id: null, changes: [] },
                    ...(planReplace ? [{ action: 'replace', key: KEPT.external_id, name: KEPT.name, type: 'ping', monitor_id: KEPT.id, changes: [{ field: 'type', from: 'http', to: 'ping' }] }] : []),
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
    planReplace = false;
    applyStatus = 200;
    echoPlan = 'none';
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

test('a type-change replace is destructive: refused without --allow-replace or --prune, sent with the fingerprint when allowed', async () => {
    fingerprint = 'fp_replace';
    planReplace = true;
    const refused = await sutramx(['apply', '-f', manifest(), '--auto-approve']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /1 monitor changed type and would be deleted with its history and created again; pass --allow-replace/);
    assert.equal(applyCalls().length, 0);

    const allowed = await sutramx(['apply', '-f', manifest(), '--auto-approve', '--allow-replace']);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(allowed.stdout, /1 to replace/);
    assert.equal(applyCalls()[0].body.expected_fingerprint, 'fp_replace');
    assert.equal(applyCalls()[0].body.prune, false);
});

test('older API without fingerprints: a replace needs --force-prune-without-plan-check too', async () => {
    planReplace = true;
    const refused = await sutramx(['apply', '-f', manifest(), '--auto-approve', '--allow-replace']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /cannot verify .*1 monitor shown/);
    const forced = await sutramx(['apply', '-f', manifest(), '--auto-approve', '--allow-replace', '--force-prune-without-plan-check']);
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(applyCalls()[0].body.allow_prune_without_fingerprint, true);
});

test('SUTRAMX_API_KEY for another workspace than the saved login: plan shows it, a prune is refused unless --workspace confirms', async () => {
    fingerprint = 'fp_ws';
    const config = join(mkdtempSync(join(tmpdir(), 'sutramx-cfg-')), 'credentials.json');
    writeFileSync(config, JSON.stringify({ api_key: 'sk_saved', workspace_id: 'ws_saved' }), { mode: 0o600 });
    const env = { SUTRAMX_CONFIG: config };

    const plan = await sutramx(['plan', '-f', manifest()], { env });
    assert.equal(plan.code, 0, plan.stderr);
    assert.match(plan.stdout, /Workspace: ws_1/);
    assert.match(plan.stdout, /acts on workspace ws_1, not ws_saved/);

    const refused = await sutramx(['apply', '-f', manifest(), '--prune', '--auto-approve'], { env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /acts on workspace ws_1, not ws_saved .*pass --workspace ws_1/);
    assert.equal(applyCalls().length, 0);

    const wrong = await sutramx(['apply', '-f', manifest(), '--auto-approve', '--workspace', 'ws_saved'], { env });
    assert.equal(wrong.code, 1);
    assert.equal(applyCalls().length, 0);

    const confirmed = await sutramx(['apply', '-f', manifest(), '--prune', '--auto-approve', '--workspace', 'ws_1'], { env });
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.equal(applyCalls().length, 1);
});

test('CI: ${VAR} reads nothing unless SUTRAMX_ALLOWED_ENV lists it, and expanded values never reach the output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sutramx-env-'));
    const file = join(dir, 'sutramx.yml');
    writeFileSync(file, 'monitors:\n  - key: staging\n    name: "Staging ${RUNNER_SECRET_NAME:-x}"\n    url: "${STAGING_URL}"\n');
    const env = { CI: 'true', STAGING_URL: 'https://staging-7f3a9c.example.com/health', RUNNER_SECRET_NAME: 'ghp_runnerSecretValue123' };

    const denied = await sutramx(['plan', '-f', file], { env });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /STAGING_URL \(at monitors\[0\]\.url\)/);
    assert.match(denied.stderr, /RUNNER_SECRET_NAME/);
    assert.match(denied.stderr, /SUTRAMX_ALLOWED_ENV/);
    assert.equal(calls.length, 0);

    echoPlan = 'change';
    const allowed = await sutramx(['diff', '-f', file], { env: { ...env, SUTRAMX_ALLOWED_ENV: 'STAGING_URL,RUNNER_SECRET_NAME' } });
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(calls.find((call) => call.url === '/automation/monitors/plan')!.body.monitors[0].url, env.STAGING_URL);
    assert.match(allowed.stdout, /\$\{STAGING_URL\}/);
    assert.match(allowed.stdout, /Staging \$\{RUNNER_SECRET_NAME\}/);
    assert.ok(!allowed.stdout.includes('staging-7f3a9c') && !allowed.stdout.includes('runnerSecretValue'), allowed.stdout);

    const json = await sutramx(['plan', '--json', '-f', file], { env: { ...env, SUTRAMX_ALLOWED_ENV: 'STAGING_URL,RUNNER_SECRET_NAME' } });
    assert.ok(!json.stdout.includes('staging-7f3a9c') && !json.stdout.includes('runnerSecretValue'), json.stdout);

    echoPlan = 'error';
    const failed = await sutramx(['plan', '-f', file], { env: { ...env, SUTRAMX_ALLOWED_ENV: 'STAGING_*,RUNNER_SECRET_NAME' } });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Invalid monitor/);
    assert.ok(!failed.stderr.includes('staging-7f3a9c') && !failed.stderr.includes('runnerSecretValue'), failed.stderr);
});
