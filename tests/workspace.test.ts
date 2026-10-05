import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { SutramXApi } from '../src/api.js';
import { parseManifest } from '../src/manifest.js';
import { applyPlan, buildPlan, checkTarget, effectiveOptions, PlanChangedError, pruneSettingWarnings, WorkspacePlan } from '../src/workspace.js';

/** Fake API: monitors are planned/applied by the server, the rest by the CLI. */
const calls: Array<{ method: string; url: string; body?: any; }> = [];
const state = {
    monitors: [{ id: '11111111-1111-4111-8111-111111111111', external_id: 'homepage', name: 'Homepage' }] as Array<{ id: string; external_id: string | null; name: string; }>,
    pages: [] as Array<{ id: string; slug: string; title: string; is_public?: boolean; monitors: Array<{ id: string; section: string | null; }>; }>,
    connections: [] as Array<{ id: string; integration_type: string; name: string; config: Record<string, unknown>; routing: { scope: string; monitor_ids?: string[]; }; }>,
};
let server: http.Server;
let api: SutramXApi;
let canManageAlertChannels = true;

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
                const changes = body.monitors.map((spec: any) => {
                    const existing = state.monitors.find((monitor) => monitor.external_id === spec.key);
                    return { action: existing ? 'noop' : 'create', key: spec.key, name: spec.name, type: spec.type || 'http', monitor_id: existing?.id ?? null, changes: [] };
                });
                return send(200, { changes, summary: {} });
            }
            if (route === 'POST /automation/monitors/apply') {
                const results = body.monitors.map((spec: any) => {
                    let existing = state.monitors.find((monitor) => monitor.external_id === spec.key);
                    if (existing) return { action: 'noop', key: spec.key, name: spec.name, type: 'http', monitor_id: existing.id, changes: [], status: 'applied' };
                    existing = { id: `33333333-3333-4333-8333-33333333333${state.monitors.length}`, external_id: spec.key, name: spec.name };
                    state.monitors.push(existing);
                    return { action: 'create', key: spec.key, name: spec.name, type: 'http', monitor_id: existing.id, changes: [], status: 'applied' };
                });
                return send(200, { ok: true, results });
            }
            if (route === 'GET /automation/whoami') return send(200, { can_manage_alert_channels: canManageAlertChannels });
            if (route === 'GET /monitors') return send(200, state.monitors);
            if (route === 'GET /status/pages/me') return send(200, state.pages);
            if (req.method === 'GET' && req.url!.startsWith('/status/pages/')) return send(200, state.pages.find((page) => page.id === req.url!.split('/')[3]));
            if (route === 'POST /status/pages') {
                const page = { id: `page-${state.pages.length + 1}`, slug: `generated-${state.pages.length + 1}`, title: body.title, is_public: body.is_public, monitors: [] };
                state.pages.push(page);
                return send(201, page);
            }
            if (req.method === 'PATCH' && req.url!.startsWith('/status/pages/')) {
                const page = state.pages.find((item) => item.id === req.url!.split('/')[3])!;
                Object.assign(page, body);
                return send(200, page);
            }
            if (req.method === 'PUT' && req.url!.endsWith('/monitors')) {
                const page = state.pages.find((item) => item.id === req.url!.split('/')[3])!;
                page.monitors = body.monitors.map((entry: any) => ({ id: entry.monitor_id, section: entry.section ?? null }));
                return send(200, page);
            }
            if (route === 'GET /integrations') return send(200, { connections: state.connections });
            if (route === 'POST /integrations/slack/connections') {
                state.connections.push({ id: 'conn-1', integration_type: 'slack', name: body.name, config: { webhook_url: 'https://hooks.slack.com/…1234' }, routing: body.routing });
                return send(200, { success: true });
            }
            send(404, { error: `no route ${route}` });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = new SutramXApi('sk_test', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});

after(() => server.close());

const MANIFEST = parseManifest(`
monitors:
  - key: homepage
    name: Homepage
    url: https://example.com
  - key: api
    name: API
    url: https://api.example.com
status_pages:
  - slug: acme
    title: Acme status
    is_public: true
    monitors: [homepage, { key: api, section: Backend }]
integrations:
  - name: Ops
    type: slack
    config: { webhook_url: "https://hooks.slack.com/services/T/B/xx1234" }
    routing: { scope: monitors, monitors: [api] }
`, {});

test('plan covers monitors (server), status pages and integrations (client)', async () => {
    const plan = await buildPlan(api, MANIFEST, effectiveOptions(MANIFEST, {}));
    assert.equal(plan.hasChanges, true);
    assert.deepEqual(plan.monitors.changes.map((change) => change.action), ['noop', 'create']);
    assert.equal(plan.statusPages[0].action, 'create');
    assert.equal(plan.integrations[0].action, 'create');
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.blockers, []);
});

test('a standard key is told up front that it cannot change integrations', async () => {
    canManageAlertChannels = false;
    try {
        const plan = await buildPlan(api, MANIFEST, effectiveOptions(MANIFEST, {}));
        assert.equal(plan.blockers.length, 1);
        assert.match(plan.blockers[0], /"Automation"/);
    } finally {
        canManageAlertChannels = true;
    }
});

test('apply creates monitors first, then wires new monitor ids into integrations and pages; a second plan is clean', async () => {
    const outcome = await applyPlan(api, MANIFEST, effectiveOptions(MANIFEST, {}));
    assert.equal(outcome.ok, true, JSON.stringify(outcome.steps));
    assert.deepEqual(outcome.steps.map((step) => `${step.kind}:${step.action}:${step.status}`), [
        'monitor:create:applied', 'integration:create:applied', 'status_page:create:applied',
    ]);
    const apiId = state.monitors.find((monitor) => monitor.external_id === 'api')!.id;
    assert.deepEqual(state.connections[0].routing, { scope: 'monitors', monitor_ids: [apiId] });
    assert.equal(state.pages[0].slug, 'acme');
    assert.deepEqual(state.pages[0].monitors, [
        { id: '11111111-1111-4111-8111-111111111111', section: null },
        { id: apiId, section: 'Backend' },
    ]);

    const again = await buildPlan(api, MANIFEST, effectiveOptions(MANIFEST, {}));
    assert.equal(again.hasChanges, false, JSON.stringify(again, null, 1));
});

test('adopt_by_name may come from the file; deletes only from command-line flags', () => {
    const manifest = parseManifest('settings: { prune: true, adopt_by_name: true, prune_integrations: true }\nmonitors: []\n', {});
    assert.deepEqual(effectiveOptions(manifest, {}), { prune: false, adoptByName: true, pruneIntegrations: false });
    assert.equal(effectiveOptions(manifest, { prune: true }).prune, true);
    assert.equal(effectiveOptions(manifest, { prune: false }).prune, false);
    assert.equal(effectiveOptions(manifest, { pruneIntegrations: true }).pruneIntegrations, true);
    assert.equal(pruneSettingWarnings(manifest, {}).length, 2);
    assert.deepEqual(pruneSettingWarnings(manifest, { prune: true, pruneIntegrations: true }), []);
});

test('routing to a monitor key that is neither declared nor existing blocks apply (never routes to an empty list)', async () => {
    const manifest = parseManifest(`
monitors:
  - { key: homepage, name: Homepage, url: https://example.com }
integrations:
  - name: Typo
    type: slack
    config: { webhook_url: "https://hooks.slack.com/services/T/B/zz9999" }
    routing: { scope: monitors, monitors: [hompage] }
`, {});
    const plan = await buildPlan(api, manifest, effectiveOptions(manifest, {}));
    assert.equal(plan.blockers.length, 1);
    assert.match(plan.blockers[0], /slack\/Typo routes to unknown monitor keys: hompage/);
});

test('integrations are planned once: a change made after the review stops apply before anything is applied', async () => {
    const manifest = parseManifest(`
monitors:
  - { key: homepage, name: Homepage, url: https://example.com }
integrations:
  - name: Late
    type: slack
    config: { webhook_url: "https://hooks.slack.com/services/T/B/ll1234" }
`, {});
    const options = effectiveOptions(manifest, {});
    const reviewed = await buildPlan(api, manifest, options);
    assert.equal(reviewed.integrations[0].action, 'create');
    assert.match(reviewed.fingerprint, /^sha256:[0-9a-f]{64}$/);
    // Someone creates a different "Late" (another secret) after the plan was shown.
    state.connections.push({ id: 'conn-late', integration_type: 'slack', name: 'Late', config: { webhook_url: 'https://hooks.slack.com/…0000' }, routing: { scope: 'all' } });
    const before = calls.length;
    await assert.rejects(applyPlan(api, manifest, { ...options, reviewed }), PlanChangedError);
    assert.ok(!calls.slice(before).some((call) => call.method !== 'GET'), 'nothing was written');
});

test('target workspace: a key for another workspace blocks destructive applies unless --workspace confirms it', () => {
    const plan = (actions: string[]): WorkspacePlan => ({
        monitors: { changes: actions.map((action, index) => ({ action: action as any, key: `k${index}`, name: 'n', type: 'http', monitor_id: 'm', changes: [] })), summary: {} as any },
        statusPages: [], integrations: [], warnings: [], blockers: [], hasChanges: true, target: { workspace_id: 'ws_ci' }, fingerprint: 'x',
    });
    const fromEnv = { savedWorkspace: 'ws_login', keySource: 'env' as const };
    assert.deepEqual(checkTarget(plan(['delete']), fromEnv).blockers.length, 1);
    assert.match(checkTarget(plan(['replace']), fromEnv).blockers[0], /acts on workspace ws_ci, not ws_login .*SUTRAMX_API_KEY overrides.*--workspace ws_ci/);
    // Non-destructive: a warning only.
    const create = checkTarget(plan(['create']), fromEnv);
    assert.deepEqual(create.blockers, []);
    assert.equal(create.warnings.length, 1);
    // Explicit confirmation, and the file's declared workspace.
    assert.deepEqual(checkTarget(plan(['delete']), { ...fromEnv, confirmedWorkspace: 'ws_ci' }), { warnings: [], blockers: [] });
    assert.equal(checkTarget(plan(['create']), { confirmedWorkspace: 'ws_other' }).blockers.length, 1);
    assert.match(checkTarget(plan(['delete']), { declaredWorkspace: 'ws_prod' }).blockers[0], /settings\.workspace_id/);
    assert.deepEqual(checkTarget(plan(['delete']), { declaredWorkspace: 'ws_ci', savedWorkspace: 'ws_ci' }), { warnings: [], blockers: [] });
});
