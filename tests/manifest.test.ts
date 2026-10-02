import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';
import { exportMonitors, SAMPLE_MANIFEST, slugKey } from '../src/exportManifest.js';
import { interpolateEnv, ManifestError, monitorSpecs, parseManifest } from '../src/manifest.js';
import { createMonitorResolver, matchesMasked, planIntegrations, planStatusPages } from '../src/reconcile.js';

test('the sample manifest is valid', () => {
    const manifest = parseManifest(SAMPLE_MANIFEST, {});
    assert.equal(manifest.monitors.length, 3);
});

test('env references are expanded; missing ones are errors, defaults and $$ escapes work', () => {
    const missing: string[] = [];
    const out = interpolateEnv({ a: '${A}', b: ['x-${B:-fallback}'], c: '$${LITERAL}' }, { A: 'one' }, '', missing) as any;
    assert.deepEqual(out, { a: 'one', b: ['x-fallback'], c: '${LITERAL}' });
    assert.deepEqual(missing, []);
    assert.throws(
        () => parseManifest('integrations:\n  - name: s\n    type: slack\n    config:\n      webhook_url: ${SLACK_URL}\n', {}),
        (error: unknown) => error instanceof ManifestError && /SLACK_URL \(at integrations\[0\]\.config\.webhook_url\)/.test(error.message),
    );
});

test('structure errors and duplicate keys are reported together', () => {
    assert.throws(() => parseManifest('monitors:\n  - key: a\n    name: A\n  - key: a\n    name: B\n', {}), /duplicate monitor key: a/);
    assert.throws(() => parseManifest('monitors:\n  - key: "-bad"\n    name: A\n', {}), /monitors\.0\.key/);
    assert.throws(() => parseManifest('monitors:\n  - key: a\n    name: A\n    colour: red\n', {}), /colour|Unrecognized/);
    assert.throws(() => parseManifest('monitors: [', {}), /not valid YAML/);
});

test('defaults merge into monitor specs without overriding explicit values', () => {
    const manifest = parseManifest(`
defaults:
  interval_seconds: 120
  regions: [bom, sin]
  tags: [prod]
  config: { timeout: 5000 }
monitors:
  - key: a
    name: A
    url: https://a.example.com
  - key: b
    name: B
    url: https://b.example.com
    interval_seconds: 30
    regions: null
    tags: [api]
    config: { timeout: 9000, keyword: ok }
`, {});
    const [a, b] = monitorSpecs(manifest);
    assert.deepEqual(a, { key: 'a', name: 'A', url: 'https://a.example.com', interval_seconds: 120, regions: ['bom', 'sin'], tags: ['prod'], config: { timeout: 5000 } });
    assert.equal(b.interval_seconds, 30);
    assert.equal(b.regions, null);
    assert.deepEqual(b.tags, ['prod', 'api']);
    assert.deepEqual(b.config, { timeout: 9000, keyword: 'ok' });
});

test('masked secrets match by visible tail and origin', () => {
    assert.equal(matchesMasked('https://hooks.slack.com/services/T0/B0/abcd1234', 'https://hooks.slack.com/…1234'), true);
    assert.equal(matchesMasked('https://hooks.slack.com/services/T0/B0/abcd9999', 'https://hooks.slack.com/…1234'), false);
    assert.equal(matchesMasked('https://evil.example.com/x/1234', 'https://hooks.slack.com/…1234'), false);
    assert.equal(matchesMasked('r0utingkey5678', '…5678'), true);
    assert.equal(matchesMasked('owner/repo', 'owner/repo'), true);
    assert.equal(matchesMasked('owner/repo', 'owner/other'), false);
});

const resolver = createMonitorResolver([
    { id: '11111111-1111-4111-8111-111111111111', external_id: 'homepage' },
    { id: '22222222-2222-4222-8222-222222222222', external_id: null },
], ['homepage', 'api']);

test('status pages are planned by slug with monitors resolved from keys', () => {
    const pages = parseManifest(`
status_pages:
  - slug: acme
    title: Acme status
    is_public: true
    monitors: [homepage, { key: api, section: API }, ghost]
  - slug: same
    title: Same
    monitors: [homepage]
`, {}).status_pages!;
    const plan = planStatusPages(pages, [
        { id: 'p2', slug: 'same', title: 'Same', is_public: true, monitors: [{ id: '11111111-1111-4111-8111-111111111111', section: null }] },
    ], resolver);
    assert.equal(plan[0].action, 'create');
    assert.deepEqual(plan[0].unknownMonitors, ['ghost']);
    assert.equal(plan[1].action, 'noop');
});

test('integrations: create, update on routing/secret change, prune only declared types', () => {
    const integrations = parseManifest(`
integrations:
  - name: Ops
    type: slack
    config: { webhook_url: "https://hooks.slack.com/services/T/B/newsecret9" }
    routing: { scope: monitors, monitors: [homepage] }
  - name: Hook
    type: webhook
    config: { webhook_url: "https://example.com/hook" }
`, {}).integrations!;
    const plan = planIntegrations(integrations, [
        { id: 'c1', integration_type: 'slack', name: 'Ops', config: { webhook_url: 'https://hooks.slack.com/…ret1' }, routing: { scope: 'all' } },
        { id: 'c2', integration_type: 'slack', name: 'Old', config: {}, routing: { scope: 'all' } },
        { id: 'c3', integration_type: 'pagerduty', name: 'PD', config: {}, routing: { scope: 'all' } },
    ], resolver, { prune: true });
    const summary = plan.map((change) => `${change.action}:${change.type}/${change.name}`);
    assert.deepEqual(summary, ['delete:slack/Old', 'update:slack/Ops', 'create:webhook/Hook']);
    assert.deepEqual(plan[1].changes.map((change) => change.field), ['config.webhook_url', 'routing']);
});

test('exportMonitors writes keys for every monitor and flags duplicate names', () => {
    const { yaml, adopted, duplicateNames } = exportMonitors([
        { id: '1', external_id: 'kept', name: 'Kept', type: 'http', url: 'https://k.example.com', interval_seconds: 60, is_active: true, config: { notification_emails: ['a@b.c'] } },
        { id: '2', name: 'Shop Front!', type: 'http', url: 'https://s.example.com', interval_seconds: 120, is_active: false, tags: ['prod'], probe_regions: ['bom'] },
        { id: '3', name: 'Shop Front!', type: 'http', url: 'https://s2.example.com', interval_seconds: 120, is_active: true },
    ]);
    const doc = parse(yaml);
    assert.equal(adopted, 2);
    assert.deepEqual(duplicateNames, ['http/Shop Front!']);
    assert.deepEqual(doc.monitors.map((monitor: any) => monitor.key).sort(), ['kept', 'shop-front', 'shop-front-2']);
    const paused = doc.monitors.find((monitor: any) => monitor.paused);
    assert.deepEqual(paused.regions, ['bom']);
    assert.equal(doc.monitors.find((monitor: any) => monitor.key === 'kept').config, undefined, 'notification_emails is not exported');
    assert.equal(doc.settings.adopt_by_name, true);
    assert.doesNotThrow(() => parseManifest(yaml, {}));
    assert.equal(slugKey('***'), 'monitor');
});
