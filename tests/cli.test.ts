import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { monitorSpecs, parseManifest } from '../src/manifest.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const MONITOR_TYPES = ['http', 'api', 'ping', 'port', 'udp', 'dns', 'multistep', 'mcp', 'cron'];

/** `sutramx <args> --help`, from source, with no saved credentials or API key. */
function help(...args: string[]): string {
    const env: NodeJS.ProcessEnv = { ...process.env, SUTRAMX_CONFIG: join(mkdtempSync(join(tmpdir(), 'sutramx-help-')), 'none.json'), NO_COLOR: '1', COLUMNS: '200' };
    delete env.SUTRAMX_API_KEY;
    return execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/index.ts'), ...args, '--help'], { cwd: ROOT, env, encoding: 'utf8' });
}

const COMMANDS = [
    [], ['login'], ['logout'], ['whoami'],
    ['monitors'], ['monitors', 'list'], ['monitors', 'get'], ['monitors', 'create'], ['monitors', 'update'], ['monitors', 'delete'], ['monitors', 'pause'], ['monitors', 'resume'],
    ['monitors', 'checks'], ['monitors', 'run-check'], ['monitors', 'adopt'],
    ['incidents'], ['incidents', 'list'], ['incidents', 'get'], ['incidents', 'ack'], ['incidents', 'resolve'], ['incidents', 'note'],
    ['status-pages'], ['status-pages', 'list'], ['status-pages', 'get'], ['uptime'], ['why'],
    ['maintenance'], ['maintenance', 'list'],
    ['regions'], ['init'], ['validate'], ['plan'], ['diff'], ['apply'],
];

test('monitors create --help lists every monitor type the API accepts', () => {
    const text = help('monitors', 'create').replace(/\s+/g, ' ');
    for (const type of MONITOR_TYPES) assert.match(text, new RegExp(`--type <type> .*\\b${type}\\b`), `--type help misses ${type}`);
});

test('README documents every command and flag the CLI implements', () => {
    for (const args of COMMANDS) {
        const text = help(...args);
        if (args.length) assert.ok(README.includes(`sutramx ${args.join(' ')}`) || README.includes(`\`${args[args.length - 1]} <`), `README misses "sutramx ${args.join(' ')}"`);
        const flags = [...text.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/gm)].map((match) => match[1]).filter((flag) => flag !== '--help');
        for (const flag of new Set(flags)) assert.ok(README.includes(flag), `README misses ${flag} (sutramx ${args.join(' ')})`);
    }
    for (const type of MONITOR_TYPES) assert.ok(README.includes(`\`${type}\``), `README misses monitor type ${type}`);
});

test('the README names no internal hosts, addresses or paths', () => {
    assert.doesNotMatch(README, /\/Users\/|NPM_TOKEN repository secret/);
    const addresses = (README.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || []).filter((ip) => ip !== '127.0.0.1');
    assert.deepEqual(addresses, []);
});

test('sutramx.yml accepts dns and multistep monitors (the API validates their config)', () => {
    const manifest = parseManifest([
        'monitors:',
        '  - key: mx',
        '    name: MX records',
        '    type: dns',
        '    config: { hostname: example.com, record_type: MX }',
        '  - key: login-flow',
        '    name: Login flow',
        '    type: multistep',
        '    config:',
        '      steps:',
        '        - { name: Login, method: POST, url: "https://api.example.com/login" }',
    ].join('\n'), {});
    assert.deepEqual(monitorSpecs(manifest).map((spec) => spec.type), ['dns', 'multistep']);
});

test('sutramx.yml accepts mcp monitors with url, headers from env and drift settings', () => {
    const manifest = parseManifest([
        'monitors:',
        '  - key: docs-mcp',
        '    name: Docs MCP',
        '    type: mcp',
        '    url: https://mcp.example.com/mcp',
        '    config:',
        '      headers: { Authorization: "Bearer ${MCP_TOKEN}" }',
        '      expected_tools: [search_docs]',
        '      drift_mode: alert_on_change',
        '      drift_scope: names',
        '      drift_severity: down',
    ].join('\n'), { MCP_TOKEN: 'abc' });
    const [spec] = monitorSpecs(manifest);
    assert.equal(spec.type, 'mcp');
    assert.equal(spec.url, 'https://mcp.example.com/mcp');
    assert.deepEqual(spec.config, {
        headers: { Authorization: 'Bearer abc' }, expected_tools: ['search_docs'], drift_mode: 'alert_on_change', drift_scope: 'names', drift_severity: 'down',
    });
});
