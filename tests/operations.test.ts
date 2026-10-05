import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ApiError, SutramXApi } from '../src/api.js';
import {
    acknowledgeIncident, addIncidentNote, getIncident, getStatusPage, listChecks, listIncidents, listMaintenance, renderChecks, renderIncident,
    renderIncidentTable, renderMaintenanceTable, renderMonitor, renderUptimeReport, resolveIncident, runCheck, updateMonitor, uptimeReport,
} from '../src/operations.js';

const INCIDENT_ID = '33333333-3333-4333-8333-333333333333';
const MONITOR_ID = '11111111-1111-4111-8111-111111111111';
const INCIDENT = {
    id: INCIDENT_ID, monitor_id: MONITOR_ID, monitor_name: 'Checkout\u001b[2J API', monitor_url: 'https://example.com',
    started_at: '2026-10-01T10:00:00.000Z', resolved_at: null, duration_seconds: null, acknowledged_at: null,
    confirming_region_names: ['Mumbai', 'Frankfurt'],
};

interface Call { method: string; url: URL; auth?: string; body?: unknown; }
let calls: Call[] = [];
let respond: (call: Call) => { status: number; body?: unknown; };
const realFetch = globalThis.fetch;

beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers || {}) as Record<string, string>;
        const call: Call = { method: init?.method || 'GET', url: new URL(String(input)), auth: headers.Authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const { status, body } = respond(call);
        return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

test('incidents list sends filters as query parameters with the key', async () => {
    respond = () => ({ status: 200, body: { items: [INCIDENT], total: 30, page: 1, page_size: 25, counts: {} } });
    const list = await listIncidents(client(), { status: 'ongoing', monitorId: MONITOR_ID, search: 'checkout', from: '2026-10-01', page: 1, pageSize: 25 });
    assert.equal(list.items.length, 1);
    const call = calls[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.url.pathname, '/incidents');
    assert.equal(call.url.searchParams.get('status'), 'ongoing');
    assert.equal(call.url.searchParams.get('monitor_id'), MONITOR_ID);
    assert.equal(call.url.searchParams.get('q'), 'checkout');
    assert.equal(call.url.searchParams.get('from'), '2026-10-01');
    assert.equal(call.url.searchParams.get('page_size'), '25');
    assert.equal(call.url.searchParams.has('to'), false);
    assert.equal(call.auth, 'Bearer sk_test');

    const text = renderIncidentTable(list);
    assert.match(text, /ongoing/);
    assert.match(text, /Mumbai,Frankfurt/);
    assert.match(text, /--page 2/);
    assert.doesNotMatch(text, /\u001b\[2J/, 'control characters from server data are stripped');
});

test('incidents list rejects bad filters before calling the API', async () => {
    respond = () => ({ status: 200, body: { items: [], total: 0, page: 1, page_size: 25 } });
    await assert.rejects(listIncidents(client(), { status: 'open' }), /--status/);
    await assert.rejects(listIncidents(client(), { from: '2026-10-01&status=all' }), /ISO-8601/);
    await assert.rejects(listIncidents(client(), { monitorId: '../monitors' }), /--monitor/);
    assert.equal(calls.length, 0);
    assert.equal(renderIncidentTable({ items: [], total: 0, page: 1, page_size: 25 }), 'No incidents.');
});

test('incidents get unwraps {incident, ...timeline} and keeps the raw body for --json', async () => {
    respond = () => ({ status: 200, body: { incident: { ...INCIDENT, resolved_at: '2026-10-01T10:30:00Z', duration_seconds: 1800, acknowledged_at: '2026-10-01T10:05:00Z', acknowledged_by_name: 'Asha' }, events: [{ type: 'started' }] } });
    const { incident, raw } = await getIncident(client(), INCIDENT_ID);
    assert.equal(calls[0].url.pathname, `/incidents/${INCIDENT_ID}`);
    assert.deepEqual(raw.events, [{ type: 'started' }]);
    const text = renderIncident(incident);
    assert.match(text, /state +resolved/);
    assert.match(text, /after 30m/);
    assert.match(text, /by Asha/);
    await assert.rejects(getIncident(client(), 'not-a-uuid'), /UUID/);
});

test('incidents ack and resolve POST to the incident endpoints', async () => {
    respond = (call) => ({ status: 200, body: { incident: { ...INCIDENT, ...(call.url.pathname.endsWith('/resolve') ? { resolved_at: '2026-10-01T11:00:00Z' } : { acknowledged_at: '2026-10-01T10:01:00Z' }) } } });
    const acked = await acknowledgeIncident(client(), INCIDENT_ID);
    assert.ok(acked.acknowledged_at);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url.pathname, `/incidents/${INCIDENT_ID}/acknowledge`);

    const resolved = await resolveIncident(client(), INCIDENT_ID, 'Rolled back the deploy');
    assert.ok(resolved.resolved_at);
    assert.equal(calls[1].url.pathname, `/incidents/${INCIDENT_ID}/resolve`);
    assert.deepEqual(calls[1].body, { note: 'Rolled back the deploy' });

    await resolveIncident(client(), INCIDENT_ID);
    assert.deepEqual(calls[2].body, {});
});

test('resolving an already resolved incident surfaces the API error code', async () => {
    respond = () => ({ status: 409, body: { error: 'Incident is already resolved', code: 'INCIDENT_RESOLVED' } });
    await assert.rejects(resolveIncident(client(), INCIDENT_ID), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'INCIDENT_RESOLVED');
    assert.equal(calls.length, 1, 'POST is not retried on 409');
});

test('a read-only key cannot acknowledge (403 READ_ONLY_ACCESS is passed through)', async () => {
    respond = () => ({ status: 403, body: { error: 'This API key is read-only.', code: 'READ_ONLY_ACCESS' } });
    await assert.rejects(acknowledgeIncident(client(), INCIDENT_ID), (error: unknown) => error instanceof ApiError && error.code === 'READ_ONLY_ACCESS');
});

test('maintenance list reads /maintenance, filters by effective status and renders scope', async () => {
    const windows = [
        { id: 'a', title: 'DB upgrade', status: 'scheduled', effectiveStatus: 'ongoing', startTime: '2026-10-02T01:00:00.000Z', endTime: '2026-10-02T03:00:00.000Z', scopeType: 'monitor', monitorNames: ['Postgres'], recurrence: { type: 'none' } },
        { id: 'b', title: 'Weekly patching', status: 'scheduled', effectiveStatus: 'scheduled', startTime: '2026-10-05T01:00:00.000Z', endTime: '2026-10-05T02:00:00.000Z', scopeType: 'global', recurrence: { type: 'weekly', weekdays: [0] } },
    ];
    respond = () => ({ status: 200, body: windows });
    const all = await listMaintenance(client());
    assert.equal(calls[0].url.pathname, '/maintenance');
    assert.equal(all.length, 2);
    const text = renderMaintenanceTable(all);
    assert.match(text, /monitors: Postgres/);
    assert.match(text, /all monitors/);
    assert.match(text, /weekly/);

    const ongoing = await listMaintenance(client(), 'ongoing');
    assert.deepEqual(ongoing.map((window) => window.id), ['a']);
    await assert.rejects(listMaintenance(client(), 'active'), /--status/);
    assert.equal(renderMaintenanceTable([]), 'No maintenance windows.');
});

test('monitors update sends only the changed fields, then the regions', async () => {
    respond = (call) => ({ status: 200, body: call.method === 'PUT' && call.url.pathname.endsWith('/regions') ? { ok: true } : { id: MONITOR_ID, name: 'New name' } });
    const monitor = await updateMonitor(client(), MONITOR_ID, { name: 'New name', interval_seconds: undefined, regions: ['fra1'] });
    assert.equal(monitor.name, 'New name');
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url.pathname}`), [`PUT /monitors/${MONITOR_ID}`, `PUT /monitors/${MONITOR_ID}/regions`, `GET /monitors/${MONITOR_ID}`]);
    assert.deepEqual(calls[0].body, { name: 'New name' });
    assert.deepEqual(calls[1].body, { regions: ['fra1'] });
    await assert.rejects(updateMonitor(client(), MONITOR_ID, {}), /Nothing to change/);
    await assert.rejects(updateMonitor(client(), MONITOR_ID, { regions: ['FRA 1'] }), /region code/);
    await assert.rejects(updateMonitor(client(), '../admin', { name: 'x' }), /UUID/);
});

test('monitors checks and run-check use the monitor endpoints and validate filters', async () => {
    respond = (call) => ({ status: 200, body: call.method === 'POST'
        ? { region: 'fra1', status: 'down', response_time_ms: 120, status_code: 503, error_message: 'Bad\u001b[2J gateway' }
        : { items: [{ checked_at: '2026-10-01T10:00:00Z', region: 'fra1', status: 'down', response_time_ms: 120, status_code: 503, error_message: 'boom' }], next_before: '2026-10-01T09:00:00Z' } });
    const page = await listChecks(client(), MONITOR_ID, { limit: 10, status: 'problem', region: 'fra1' });
    assert.equal(calls[0].url.pathname, `/monitors/${MONITOR_ID}/checks`);
    assert.equal(calls[0].url.searchParams.get('status'), 'problem');
    assert.equal(calls[0].url.searchParams.get('limit'), '10');
    assert.match(renderChecks(page), /--before 2026-10-01T09:00:00Z/);
    await assert.rejects(listChecks(client(), MONITOR_ID, { before: '2026-01-01&x=1' }), /ISO-8601/);
    await assert.rejects(listChecks(client(), MONITOR_ID, { status: 'bogus' }), /--status/);
    const result = await runCheck(client(), MONITOR_ID);
    assert.equal(calls.at(-1)!.method, 'POST');
    assert.equal(calls.at(-1)!.url.pathname, `/monitors/${MONITOR_ID}/run-check`);
    assert.equal(result.status_code, 503);
});

test('monitors get renders a readable summary without control characters', () => {
    const text = renderMonitor({ id: MONITOR_ID, name: 'Checkout\u001b[2J', type: 'http', url: 'https://example.com', current_status: 'up', interval_seconds: 60, uptime_24h: 99.5, tags: ['prod'] });
    assert.match(text, /monitor {5}Checkout\[2J/);
    assert.match(text, /24h 99\.5%/);
    assert.doesNotMatch(text, /\u001b/);
});

test('status-pages get resolves a slug through the workspace list', async () => {
    const PAGE_ID = '55555555-5555-4555-8555-555555555555';
    respond = (call) => ({ status: 200, body: call.url.pathname === '/status/pages/me' ? [{ id: PAGE_ID, slug: 'acme', title: 'Acme' }] : { id: PAGE_ID, slug: 'acme', title: 'Acme', monitors: [] } });
    const page = await getStatusPage(client(), 'acme');
    assert.equal(page.id, PAGE_ID);
    assert.equal(calls.at(-1)!.url.pathname, `/status/pages/${PAGE_ID}`);
    await assert.rejects(getStatusPage(client(), 'missing'), /No status page/);
    await assert.rejects(getStatusPage(client(), '../x'), /id \(UUID\) or slug/);
});

test('uptime report uses the reliability endpoints and weights uptime by checks', async () => {
    respond = () => ({ status: 200, body: { healthScores: [
        { monitor_id: MONITOR_ID, monitor_name: 'A', uptime_percentage: 100, incident_count: 0, mttr_minutes: 0, total_checks: 300, score: 100 },
        { monitor_id: '22222222-2222-4222-8222-222222222222', monitor_name: 'B', uptime_percentage: 90, incident_count: 2, mttr_minutes: 12, total_checks: 100, score: 70 },
    ], burnRates: [] } });
    const report = await uptimeReport(client(), 7);
    assert.equal(calls[0].url.pathname, '/reliability/overview');
    assert.equal(calls[0].url.searchParams.get('days'), '7');
    assert.equal(report.overall_uptime_percentage, 97.5);
    assert.equal(report.incident_count, 2);
    assert.match(renderUptimeReport(report), /97\.5%/);
    await assert.rejects(uptimeReport(client(), 5), /--days/);
});

test('incident notes are internal by default and validated', async () => {
    respond = (call) => ({ status: 201, body: { note: { id: 'n1', ...(call.body as object) } } });
    await addIncidentNote(client(), INCIDENT_ID, '  Investigating  ', false);
    assert.deepEqual(calls[0].body, { body: 'Investigating', public: false });
    await assert.rejects(addIncidentNote(client(), INCIDENT_ID, '   ', false), /empty/);
    await assert.rejects(addIncidentNote(client(), 'nope', 'x', false), /UUID/);
});
