import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ApiError, SutramXApi } from '../src/api.js';
import {
    acknowledgeIncident, getIncident, listIncidents, listMaintenance, renderIncident, renderIncidentTable,
    renderMaintenanceTable, resolveIncident,
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
