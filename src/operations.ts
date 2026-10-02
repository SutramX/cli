import type { SutramXApi } from './api.js';
import { clean, dim, green, red, table, yellow } from './render.js';

/**
 * Incidents and maintenance windows: API calls and their text rendering,
 * kept out of index.ts so they can be tested against a mocked fetch.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INCIDENT_STATUSES = ['all', 'ongoing', 'resolved', 'acknowledged', 'suppressed'] as const;
/** ISO-8601 dates/times only: they go into query strings. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface Incident {
    id: string;
    monitor_id: string;
    monitor_name: string;
    monitor_url?: string | null;
    started_at: string;
    resolved_at: string | null;
    duration_seconds: number | null;
    acknowledged_at?: string | null;
    acknowledged_by_name?: string | null;
    alert_suppressed?: boolean;
    confirming_region_names?: string[];
    [key: string]: unknown;
}

export interface IncidentList {
    items: Incident[];
    total: number;
    page: number;
    page_size: number;
    counts?: Record<string, number>;
}

export interface IncidentListOptions {
    status?: string;
    monitorId?: string;
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
}

export function requireIncidentId(value: string): string {
    if (!UUID.test(value)) throw new Error('Expected an incident id (UUID); see `sutramx incidents list`.');
    return value;
}

export async function listIncidents(api: SutramXApi, options: IncidentListOptions = {}): Promise<IncidentList> {
    const status = options.status ?? 'all';
    if (!(INCIDENT_STATUSES as readonly string[]).includes(status)) throw new Error(`--status must be one of ${INCIDENT_STATUSES.join(', ')}`);
    if (options.monitorId && !UUID.test(options.monitorId)) throw new Error('--monitor must be a monitor id (UUID) or key');
    for (const [flag, value] of [['--from', options.from], ['--to', options.to]] as const) {
        if (value && !ISO_TIME.test(value)) throw new Error(`${flag} must be an ISO-8601 date or time, e.g. 2026-01-31 or 2026-01-31T12:00:00Z`);
    }
    if (options.search && options.search.length > 200) throw new Error('--search: at most 200 characters');
    return api.get<IncidentList>('/incidents', {
        status,
        monitor_id: options.monitorId,
        q: options.search,
        from: options.from,
        to: options.to,
        page: options.page,
        page_size: options.pageSize,
    });
}

/** GET /incidents/:id answers {incident, ...timeline}; older APIs return the incident itself. */
export async function getIncident(api: SutramXApi, id: string): Promise<{ incident: Incident; raw: Record<string, unknown>; }> {
    const raw = await api.get<Record<string, unknown>>(`/incidents/${requireIncidentId(id)}`);
    const incident = (raw.incident && typeof raw.incident === 'object' ? raw.incident : raw) as Incident;
    return { incident, raw };
}

export async function acknowledgeIncident(api: SutramXApi, id: string): Promise<Incident> {
    const result = await api.post<{ incident: Incident; }>(`/incidents/${requireIncidentId(id)}/acknowledge`);
    return result.incident;
}

export async function resolveIncident(api: SutramXApi, id: string, note?: string): Promise<Incident> {
    if (note !== undefined && note.length > 5000) throw new Error('--note: at most 5000 characters');
    const result = await api.post<{ incident: Incident; }>(`/incidents/${requireIncidentId(id)}/resolve`, note ? { note } : {});
    return result.incident;
}

export function formatDuration(seconds: number | null | undefined): string {
    if (seconds == null) return '';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

function time(value: unknown): string {
    if (!value) return '';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? clean(value) : date.toISOString().replace('T', ' ').replace(/:\d{2}\.\d+Z$/, 'Z');
}

export function incidentState(incident: Incident): string {
    if (incident.resolved_at) return 'resolved';
    return incident.acknowledged_at ? 'acknowledged' : 'ongoing';
}

export function renderIncidentTable(list: IncidentList): string {
    if (!list.items.length) return 'No incidents.';
    const colour = (state: string) => (state === 'ongoing' ? red(state) : state === 'acknowledged' ? yellow(state) : green(state));
    const body = table(list.items.map((incident) => [
        incident.id, incident.monitor_name, incidentState(incident), time(incident.started_at),
        incident.resolved_at ? formatDuration(incident.duration_seconds) : 'ongoing',
        (incident.confirming_region_names || []).join(','),
    ]), ['ID', 'MONITOR', 'STATE', 'STARTED', 'DURATION', 'REGIONS'])
        .replace(/ (ongoing|acknowledged|resolved) /g, (_match, state) => ` ${colour(state)} `);
    const more = list.page * list.page_size < list.total ? `\n${dim(`Page ${list.page}, ${list.items.length} of ${list.total}. Next: --page ${list.page + 1}`)}` : '';
    return `${body}${more}`;
}

export function renderIncident(incident: Incident): string {
    const lines = [
        `incident    ${clean(incident.id)}`,
        `monitor     ${clean(incident.monitor_name)} (${clean(incident.monitor_id)})${incident.monitor_url ? ` ${clean(incident.monitor_url)}` : ''}`,
        `state       ${incidentState(incident)}${incident.alert_suppressed ? ', alerts suppressed' : ''}`,
        `started     ${time(incident.started_at)}`,
    ];
    if (incident.resolved_at) lines.push(`resolved    ${time(incident.resolved_at)} (after ${formatDuration(incident.duration_seconds)})`);
    if (incident.acknowledged_at) lines.push(`acknowledged ${time(incident.acknowledged_at)}${incident.acknowledged_by_name ? ` by ${clean(incident.acknowledged_by_name)}` : ''}`);
    if (incident.confirming_region_names?.length) lines.push(`regions     ${incident.confirming_region_names.map(clean).join(', ')}`);
    return lines.join('\n');
}

export interface MaintenanceWindow {
    id: string;
    title: string;
    description?: string;
    status: string;
    effectiveStatus?: string;
    startTime: string | null;
    endTime: string | null;
    timezone?: string;
    impact?: string;
    scopeType?: string;
    monitorNames?: string[];
    groupNames?: string[];
    recurrence?: { type?: string; weekdays?: number[]; until?: string | null; };
    [key: string]: unknown;
}

export const MAINTENANCE_STATUSES = ['scheduled', 'ongoing', 'completed', 'cancelled'] as const;

export async function listMaintenance(api: SutramXApi, status?: string): Promise<MaintenanceWindow[]> {
    if (status && !(MAINTENANCE_STATUSES as readonly string[]).includes(status)) throw new Error(`--status must be one of ${MAINTENANCE_STATUSES.join(', ')}`);
    const list = await api.get<MaintenanceWindow[]>('/maintenance');
    return status ? list.filter((window) => (window.effectiveStatus || window.status) === status) : list;
}

function maintenanceScope(window: MaintenanceWindow): string {
    if (window.scopeType === 'monitor') return `monitors: ${(window.monitorNames || []).join(', ')}`;
    if (window.scopeType === 'group') return `groups: ${(window.groupNames || []).join(', ')}`;
    return 'all monitors';
}

export function renderMaintenanceTable(list: MaintenanceWindow[]): string {
    if (!list.length) return 'No maintenance windows.';
    return table(list.map((window) => [
        window.id, window.title, window.effectiveStatus || window.status, time(window.startTime), time(window.endTime),
        window.recurrence?.type && window.recurrence.type !== 'none' ? window.recurrence.type : '', maintenanceScope(window),
    ]), ['ID', 'TITLE', 'STATUS', 'STARTS', 'ENDS', 'REPEATS', 'SCOPE']);
}
