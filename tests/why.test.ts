import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ApiError, describeError, SutramXApi } from '../src/api.js';
import { matchMonitors, renderWhy, summaryLine, why } from '../src/why.js';

const MONITOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAUSED = '33333333-3333-4333-8333-333333333333';
const INCIDENT = '44444444-4444-4444-8444-444444444444';
const OLD_INCIDENT = '55555555-5555-4555-8555-555555555555';
const UNKNOWN = '66666666-6666-4666-8666-666666666666';

const monitor = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, type: 'http', url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example.com`, interval_seconds: 60, is_active: true, current_status: 'up', ...extra,
});
const MONITORS = [
    monitor(MONITOR, 'Checkout API', { external_id: 'checkout', current_status: 'down' }),
    monitor(OTHER, 'Checkout web'),
    monitor(PAUSED, 'Blog', { is_active: false, current_status: 'paused' }),
];

const VOTES = [
    { region: 'fra1', region_name: 'Frankfurt', status: 'down', checked_at: '2026-10-10T10:00:00Z', error_type: 'http_5xx', failure_class: 'http_5xx', http_status: 503, message: 'Service\u001b[2J Unavailable', timings: { total_ms: 812 }, confirming: true },
    { region: 'in-mumbai', region_name: 'Mumbai', status: 'down', checked_at: '2026-10-10T10:00:02Z', error_type: 'timeout', failure_class: 'timeout', http_status: null, message: 'timed out', timings: null, confirming: true },
    { region: 'usa-az', region_name: 'Arizona', status: 'inconclusive', checked_at: null, error_type: null, failure_class: 'checker', http_status: null, message: null, timings: null, confirming: false },
];

function incidentExplanation(overrides: Record<string, unknown> = {}) {
    return {
        version: 1, subject: 'incident', state: 'ongoing',
        monitor: { id: MONITOR, name: 'Checkout API', type: 'http', url: 'https://checkout-api.example.com' },
        incident_id: INCIDENT, opened_at: '2026-10-10T10:00:00Z', resolved_at: null, evaluated_at: '2026-10-10T10:05:00Z',
        verdict: 'Down from 2 of 2 regions: HTTP 5xx (all regions agree); alert sent — likely not your fault: Stripe API degraded for many SutramX customers',
        fault: 'external', fault_reason: 'Stripe API degraded for many SutramX customers', is_flapping: false, votes: VOTES,
        quorum: { rule: '2 of 2 regions must agree', required: 2, considered: 2, agreeing: 2, met: true, abstaining: ['usa-az'], reduced_coverage: null, confirmation: null },
        failure: { class: 'http_5xx', label: 'HTTP 5xx', scope: 'all_regions', failing_regions: ['fra1', 'in-mumbai'], passing_regions: [] },
        alert: { notified: true, status: 'sent', reason: null, detail: 'Alert sent to 2 channels.', delivery: null },
        contributors: [{
            kind: 'vendor', title: 'Stripe API degraded for many SutramX customers', detail: 'This monitor calls Stripe API.', severity: 'likely_cause', source: 'sutramx_vendor_detection',
            data: { vendor_id: 'stripe', vendor_name: 'Stripe', status: 'active', started_at: '2026-10-10T09:55:00Z', ended_at: null, customers: 'many', official: { status_page_url: 'https://status.stripe.com' } },
        }],
        ...overrides,
    };
}

function monitorExplanation(overrides: Record<string, unknown> = {}) {
    return incidentExplanation({
        subject: 'monitor', state: 'healthy', incident_id: null, opened_at: null, verdict: 'Up from all 3 regions', fault: 'unknown', fault_reason: 'Nothing is failing.',
        monitor: { id: OTHER, name: 'Checkout web', type: 'http', url: null },
        votes: VOTES.map((vote) => ({ ...vote, status: 'up', failure_class: null, message: null, confirming: false })),
        quorum: { rule: '2 of 3 regions must agree', required: 2, considered: 3, agreeing: 0, met: false, abstaining: [], reduced_coverage: null, confirmation: null },
        failure: { class: null, label: 'No failure', scope: 'none', failing_regions: [], passing_regions: ['fra1', 'in-mumbai', 'usa-az'] },
        alert: null, contributors: [], ...overrides,
    });
}

const FLAKINESS = {
    monitor_id: MONITOR,
    windows: {
        '7d': { days: 7, score: 12, level: 'some_noise', label: 'Some noise', total_checks: 10_000, reasons: [{ kind: 'short_incidents', label: 'Short incidents' }] },
        '30d': { days: 30, score: 4, level: 'stable', label: 'Stable', total_checks: 40_000, reasons: [] },
    },
};

let calls: URL[] = [];
let routes: Record<string, { status: number; body: unknown; }> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
    calls = [];
    routes = {
        '/monitors': { status: 200, body: MONITORS },
        [`/monitors/${MONITOR}`]: { status: 200, body: MONITORS[0] },
        [`/monitors/${OTHER}`]: { status: 200, body: MONITORS[1] },
        [`/monitors/${PAUSED}`]: { status: 200, body: MONITORS[2] },
        [`/monitors/${MONITOR}/explanation`]: { status: 200, body: incidentExplanation() },
        [`/monitors/${OTHER}/explanation`]: { status: 200, body: monitorExplanation() },
        [`/monitors/${MONITOR}/flakiness`]: { status: 200, body: FLAKINESS },
        [`/monitors/${OTHER}/flakiness`]: { status: 200, body: FLAKINESS },
        [`/monitors/${PAUSED}/flakiness`]: { status: 200, body: FLAKINESS },
        [`/incidents/${INCIDENT}/explanation`]: { status: 200, body: incidentExplanation() },
        '/incidents': { status: 200, body: { items: [], total: 0, page: 1, page_size: 1 } },
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        calls.push(url);
        const route = routes[url.pathname] ?? { status: 404, body: { error: 'Not found' } };
        return new Response(JSON.stringify(route.body), { status: route.status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function client(): SutramXApi {
    const api = new SutramXApi('sk_test', 'https://api.sutramx.com');
    api.retryDelay = () => 0;
    return api;
}

const paths = () => calls.map((url) => url.pathname);

test('an incident id: votes with abstentions, quorum, failure class, fault, vendor signal and flakiness', async () => {
    const result = await why(client(), INCIDENT);
    assert.deepEqual(paths().sort(), [`/incidents/${INCIDENT}/explanation`, `/monitors/${MONITOR}`, `/monitors/${MONITOR}/flakiness`].sort());
    assert.equal(result.outcome, 'ongoing');
    assert.equal(result.monitor?.key, 'checkout');
    const view = result.explanation!;
    assert.equal(view.fault, 'external');
    assert.equal(view.quorum.met, true);
    assert.deepEqual(view.quorum.abstaining, ['usa-az']);
    assert.deepEqual(view.regions.map((vote) => [vote.region, vote.outcome, vote.abstained, vote.latency_ms]), [['fra1', 'down', false, 812], ['in-mumbai', 'down', false, null], ['usa-az', 'inconclusive', true, null]]);
    assert.deepEqual([view.vendor[0].vendor_name, view.vendor[0].likely_cause, view.vendor[0].affected_accounts], ['Stripe', true, 'many']);
    assert.equal(result.flakiness?.['7d']?.score, 12);
    assert.match(result.summary, /^Checkout API is DOWN since 2026-10-10 10:00Z \(incident 4444/);

    const text = renderWhy(result);
    assert.match(text, /fault +external: likely external · Stripe API degraded/);
    assert.match(text, /quorum +2 of 2 regions must agree: met \(2 agreeing, 2 required, 2 counted\) · abstaining: usa-az/);
    assert.match(text, /Arizona \(usa-az\) +inconclusive \(abstains\)/);
    assert.match(text, /likely cause +Stripe API degraded for many SutramX customers \(seen by many SutramX accounts\)/);
    assert.match(text, /Flakiness +7d 12\/100 Some noise · 30d 4\/100 Stable/);
    assert.doesNotMatch(text, /\u001b\[2J/, 'control characters from the monitored site are stripped');
});

test('a UUID that is not an incident is tried as a monitor; neither gives a clear error', async () => {
    const result = await why(client(), OTHER);
    assert.deepEqual(paths().slice(0, 2), [`/incidents/${OTHER}/explanation`, `/monitors/${OTHER}`]);
    assert.equal(result.outcome, 'healthy');
    assert.equal(result.incidents_total, 0);
    assert.match(result.summary, /Checkout web is up, no open incident: Up from all 3 regions\. No incidents recorded for this monitor\./);
    await assert.rejects(why(client(), UNKNOWN), /No incident or monitor with id 6666/);
});

test('a monitor key or name with an open incident explains it without a history lookup', async () => {
    const result = await why(client(), 'checkout');
    assert.equal(result.monitor?.id, MONITOR);
    assert.equal(result.outcome, 'ongoing');
    assert.ok(!paths().includes('/incidents'));
    calls = [];
    assert.equal((await why(client(), 'CHECKOUT API')).monitor?.id, MONITOR);
});

test('an ambiguous name lists the candidates and explains nothing', async () => {
    const result = await why(client(), 'check');
    assert.equal(result.outcome, 'ambiguous');
    assert.deepEqual(result.candidates?.map((item) => item.id).sort(), [MONITOR, OTHER].sort());
    assert.deepEqual(paths(), ['/monitors']);
    const text = renderWhy(result);
    assert.match(text, /2 monitors match; pass the monitor id/);
    assert.match(text, /Checkout web/);
});

test('no match, and empty or oversized input, are refused', async () => {
    await assert.rejects(why(client(), 'nothing like this'), /No monitor matches "nothing like this"/);
    await assert.rejects(why(client(), '  '), /Pass a monitor/);
    await assert.rejects(why(client(), 'x'.repeat(201)), /longer than 200/);
});

test('a paused monitor, a maintenance window and the most recent incident are called out', async () => {
    const paused = await why(client(), 'Blog');
    assert.equal(paused.outcome, 'paused');
    assert.equal(paused.explanation, null);
    assert.ok(!paths().includes(`/monitors/${PAUSED}/explanation`));
    assert.match(renderWhy(paused), /Blog is paused: no checks run, so it cannot be down\. No incidents recorded/);

    routes[`/monitors/${OTHER}`] = { status: 200, body: { ...MONITORS[1], current_status: 'maintenance' } };
    routes['/incidents'] = { status: 200, body: { items: [{ id: OLD_INCIDENT }], total: 3, page: 1, page_size: 1 } };
    routes[`/incidents/${OLD_INCIDENT}/explanation`] = { status: 200, body: incidentExplanation({ state: 'resolved', incident_id: OLD_INCIDENT, opened_at: '2026-10-09T08:00:00Z', resolved_at: '2026-10-09T08:12:00Z', verdict: 'Down from 3 of 3 regions: DNS lookup failed', fault: 'yours' }) };
    const up = await why(client(), OTHER);
    assert.equal(up.in_maintenance, true);
    assert.equal(up.incidents_total, 3);
    assert.equal(up.last_incident?.duration_seconds, 720);
    assert.match(up.summary, /maintenance window is active: alerts are silenced\. Last incident 2026-10-09 08:00Z, resolved after 12m: Down from 3 of 3 regions: DNS lookup failed\./);
    const text = renderWhy(up);
    assert.match(text, /Most recent incident/);
    assert.match(text, /fault +yours: your side/);

    calls = [];
    const without = await why(client(), OTHER, { lastIncident: false });
    assert.equal(without.last_incident, null);
    assert.ok(!paths().includes('/incidents'));
});

test('failing side lookups become notes', async () => {
    routes[`/monitors/${OTHER}/flakiness`] = { status: 500, body: { error: 'boom' } };
    routes['/incidents'] = { status: 403, body: { error: 'nope', code: 'FEATURE_NOT_AVAILABLE' } };
    const result = await why(client(), OTHER);
    assert.equal(result.flakiness, null);
    assert.deepEqual([...(result.notes || [])].sort(), ['Flakiness could not be loaded: HTTP 500', 'The most recent incident could not be loaded: HTTP 403 FEATURE_NOT_AVAILABLE']);
    assert.match(renderWhy(result), /Note: Flakiness could not be loaded/);
});

test('403 (plan) and 429 on the explanation itself are errors with hints; 429 is retried first', async () => {
    routes[`/incidents/${INCIDENT}/explanation`] = { status: 403, body: { error: 'Not on your plan', code: 'FEATURE_NOT_AVAILABLE' } };
    const plan = await why(client(), INCIDENT).catch((error) => error);
    assert.ok(plan instanceof ApiError);
    assert.match(describeError(plan), /HTTP 403 FEATURE_NOT_AVAILABLE[\s\S]*plan does not allow/);

    routes[`/incidents/${INCIDENT}/explanation`] = { status: 429, body: { error: 'Too many requests for this API key; wait and retry', code: 'RATE_LIMITED' } };
    calls = [];
    const limited = await why(client(), INCIDENT).catch((error) => error);
    assert.equal(limited.status, 429);
    assert.equal(paths().filter((path) => path === `/incidents/${INCIDENT}/explanation`).length, 4, 'retried before giving up');
    assert.match(describeError(limited), /Rate limited/);
});

test('matching prefers id, key, exact name, then a substring', () => {
    const list = [monitor(MONITOR, 'API', { external_id: 'web' }), monitor(OTHER, 'Web'), monitor(PAUSED, 'Web app')];
    assert.equal((matchMonitors(list, 'web') as any).monitor.id, MONITOR);
    assert.equal((matchMonitors(list, 'web app') as any).monitor.id, PAUSED);
    assert.equal(matchMonitors(list, 'eb').kind, 'many');
});

test('summary of a resolved incident and of a monitor without data', () => {
    const base = { monitor: null, last_incident: null, incidents_total: null, in_maintenance: false, flakiness: null };
    const explanation: any = { monitor: { name: 'Shop' }, incident_id: INCIDENT, opened_at: '2026-10-01T00:00:00Z', duration_seconds: 5400, verdict: 'Down from 2 of 3 regions: timeout' };
    assert.equal(summaryLine({ ...base, outcome: 'resolved', explanation }), `Shop incident ${INCIDENT} (2026-10-01 00:00Z, resolved after 1.5h): Down from 2 of 3 regions: timeout.`);
    assert.equal(summaryLine({ ...base, outcome: 'no_data', explanation, incidents_total: 0 }), 'Shop has no recent checks to explain. No incidents recorded for this monitor.');
});
