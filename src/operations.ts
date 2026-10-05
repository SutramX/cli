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

// ─── Monitors ────────────────────────────────────────────────────────────────

export const MONITOR_STATUSES = ['up', 'down', 'degraded', 'paused', 'pending', 'maintenance'] as const;
export const CHECK_STATUSES = ['up', 'down', 'degraded', 'problem'] as const;
const REGION_CODE = /^[a-z0-9][a-z0-9-]{0,19}$/;

export function requireRegionCode(value: string, flag = '--region'): string {
    if (!REGION_CODE.test(value)) throw new Error(`${flag}: lower-case region code, e.g. fra1 (see \`sutramx regions\`)`);
    return value;
}

export function requireMonitorId(value: string): string {
    if (!UUID.test(value)) throw new Error('Expected a monitor id (UUID).');
    return value;
}

function pct(value: unknown): string {
    return typeof value === 'number' ? `${value.toFixed(3).replace(/\.?0+$/, '')}%` : 'n/a';
}

export function renderMonitor(monitor: Record<string, any>): string {
    const regions = (monitor.effective_regions || monitor.probe_regions || []) as string[];
    const lines = [
        `monitor     ${clean(monitor.name)}`,
        `id          ${clean(monitor.id)}${monitor.external_id ? ` (key ${clean(monitor.external_id)})` : ''}`,
        `type        ${clean(monitor.type)}${monitor.url ? ` · ${clean(monitor.url)}` : ''}`,
        `status      ${clean(monitor.current_status ?? (monitor.is_active ? 'active' : 'paused'))}${monitor.open_incident ? ` · open incident ${clean(monitor.open_incident.id)} since ${time(monitor.open_incident.started_at)}` : ''}`,
        `interval    ${clean(monitor.interval_seconds)}s · regions ${regions.length ? regions.map(clean).join(', ') : 'plan default'}`,
        `uptime      24h ${pct(monitor.uptime_24h)} · 30d ${pct(monitor.uptime_30d)}`,
        `last check  ${monitor.last_checked_at ? time(monitor.last_checked_at) : 'never'}${monitor.last_status ? ` (${clean(monitor.last_status)}${monitor.last_response_time_ms != null ? `, ${clean(monitor.last_response_time_ms)} ms` : ''})` : ''}`,
    ];
    if (monitor.last_error) lines.push(`last error  ${clean(String(monitor.last_error)).replace(/\s+/g, ' ').slice(0, 300)}`);
    if (Array.isArray(monitor.tags) && monitor.tags.length) lines.push(`tags        ${monitor.tags.map(clean).join(', ')}`);
    if (monitor.heartbeat_url) lines.push(`heartbeat   ${clean(monitor.heartbeat_url)}`);
    return lines.join('\n');
}

export interface MonitorUpdate {
    name?: string;
    url?: string;
    interval_seconds?: number;
    tags?: string[];
    config?: Record<string, unknown>;
    regions?: string[];
}

/** PUT /monitors/:id with the changed fields, then PUT /monitors/:id/regions. */
export async function updateMonitor(api: SutramXApi, id: string, update: MonitorUpdate): Promise<Record<string, any>> {
    requireMonitorId(id);
    const { regions, ...fields } = update;
    const changes = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    if (!Object.keys(changes).length && !regions?.length) throw new Error('Nothing to change: pass at least one of --name, --url, --interval, --tag, --config, --region.');
    if (changes.name !== undefined && (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 255)) throw new Error('--name: 1-255 characters');
    if (changes.config !== undefined && (!changes.config || typeof changes.config !== 'object' || Array.isArray(changes.config))) throw new Error('--config must be a JSON object');
    regions?.forEach((code) => requireRegionCode(code));
    let monitor: Record<string, any> | undefined;
    if (Object.keys(changes).length) monitor = await api.put<Record<string, any>>(`/monitors/${id}`, changes);
    if (regions?.length) {
        await api.put(`/monitors/${id}/regions`, { regions });
        monitor = await api.get<Record<string, any>>(`/monitors/${id}`);
    }
    return monitor!;
}

export interface CheckRow {
    id?: string;
    checked_at: string;
    region?: string | null;
    status: string;
    response_time_ms?: number | null;
    status_code?: number | null;
    error_type?: string | null;
    error_message?: string | null;
}

export interface CheckPage {
    items: CheckRow[];
    next_before?: string | null;
}

export async function listChecks(api: SutramXApi, id: string, options: { limit?: number; before?: string; region?: string; status?: string; } = {}): Promise<CheckPage> {
    requireMonitorId(id);
    if (options.before && !ISO_TIME.test(options.before)) throw new Error('--before must be an ISO-8601 date or time');
    if (options.region) requireRegionCode(options.region);
    if (options.status && !(CHECK_STATUSES as readonly string[]).includes(options.status)) throw new Error(`--status must be one of ${CHECK_STATUSES.join(', ')}`);
    return api.get<CheckPage>(`/monitors/${id}/checks`, { limit: options.limit, before: options.before, region: options.region, status: options.status });
}

export function renderChecks(page: CheckPage): string {
    if (!page.items?.length) return 'No checks.';
    const body = table(page.items.map((row) => [
        time(row.checked_at), String(row.region ?? ''), row.status, row.response_time_ms == null ? '' : String(row.response_time_ms),
        row.status_code == null ? '' : String(row.status_code), String(row.error_type || row.error_message || '').replace(/\s+/g, ' ').slice(0, 80),
    ]), ['TIME', 'REGION', 'STATUS', 'MS', 'HTTP', 'ERROR']);
    return page.next_before ? `${body}\n${dim(`Older: --before ${clean(page.next_before)}`)}` : body;
}

export interface RunCheckResult {
    region: string;
    status: string;
    response_time_ms: number;
    status_code?: number | null;
    error_message?: string | null;
}

export async function runCheck(api: SutramXApi, id: string): Promise<RunCheckResult> {
    return api.post<RunCheckResult>(`/monitors/${requireMonitorId(id)}/run-check`);
}

export function renderRunCheck(result: RunCheckResult): string {
    const status = result.status === 'up' ? green(result.status) : result.status === 'down' ? red(result.status) : yellow(clean(result.status));
    return `Check from ${clean(result.region)}: ${status} in ${clean(result.response_time_ms)} ms${result.status_code ? ` (HTTP ${clean(result.status_code)})` : ''}${result.error_message ? `\nerror: ${clean(result.error_message).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
}

// ─── Status pages ────────────────────────────────────────────────────────────

export interface StatusPageSummary {
    id: string;
    title: string;
    slug: string;
    is_public?: boolean;
    custom_domain?: string | null;
    monitor_count?: number;
    monitors?: Array<{ id: string; name?: string; section?: string | null; }>;
    [key: string]: unknown;
}

const SLUG = /^[a-z0-9-]{1,64}$/;

export async function listStatusPages(api: SutramXApi): Promise<StatusPageSummary[]> {
    return api.get<StatusPageSummary[]>('/status/pages/me');
}

/** One page by id, or by slug (looked up in the workspace's own pages). */
export async function getStatusPage(api: SutramXApi, idOrSlug: string): Promise<StatusPageSummary> {
    let id = idOrSlug;
    if (!UUID.test(idOrSlug)) {
        if (!SLUG.test(idOrSlug)) throw new Error('Expected a status page id (UUID) or slug.');
        const page = (await listStatusPages(api)).find((item) => item.slug === idOrSlug);
        if (!page) throw new Error(`No status page with slug ${idOrSlug} in this workspace; see \`sutramx status-pages list\`.`);
        id = requireMonitorId(String(page.id));
    }
    return api.get<StatusPageSummary>(`/status/pages/${id}`);
}

export function renderStatusPages(pages: StatusPageSummary[]): string {
    if (!pages.length) return 'No status pages.';
    return table(pages.map((page) => [
        page.id, page.slug, page.title, page.is_public ? 'public' : 'not public', String(page.monitor_count ?? page.monitors?.length ?? 0), page.custom_domain || '',
    ]), ['ID', 'SLUG', 'TITLE', 'VISIBILITY', 'MONITORS', 'DOMAIN']);
}

export function renderStatusPage(page: StatusPageSummary): string {
    const lines = [
        `status page ${clean(page.title)}`,
        `id          ${clean(page.id)}`,
        `slug        ${clean(page.slug)} · ${page.is_public ? 'public' : 'not public'}${page.custom_domain ? ` · ${clean(page.custom_domain)}` : ''}`,
    ];
    const monitors = page.monitors || [];
    lines.push(monitors.length ? 'monitors' : 'monitors    none');
    for (const monitor of monitors) lines.push(`  - ${clean(monitor.name ?? monitor.id)} (${clean(monitor.id)})${monitor.section ? ` · ${clean(monitor.section)}` : ''}`);
    return lines.join('\n');
}

// ─── Uptime report ───────────────────────────────────────────────────────────

export const REPORT_DAYS = [7, 14, 30, 90] as const;

interface HealthScore { monitor_id: string; monitor_name: string; uptime_percentage: number; incident_count: number; mttr_minutes: number; total_checks: number; score: number; }
interface BurnRate { slo_id?: string; monitor_id: string; monitor_name: string; target_percentage: number; slow_window_minutes: number; fast_burn_rate: number; slow_burn_rate: number; is_alerting: boolean; error_budget?: { remaining_percentage: number; exhausted?: boolean; } | null; }

export interface UptimeReport {
    window_days: number;
    overall_uptime_percentage: number | null;
    incident_count: number;
    monitors: Array<{ monitor_id: string; monitor_name: string; uptime_percentage: number; incident_count: number; mttr_minutes: number; total_checks: number; health_score: number; }>;
    slos: BurnRate[];
}

/** Same endpoints and shape as the MCP server's sutramx_uptime_report. */
export async function uptimeReport(api: SutramXApi, days: number, monitorId?: string): Promise<UptimeReport> {
    if (!(REPORT_DAYS as readonly number[]).includes(days)) throw new Error(`--days must be one of ${REPORT_DAYS.join(', ')}`);
    let scores: HealthScore[];
    let slos: BurnRate[];
    if (monitorId) {
        const one = await api.get<{ healthScore?: HealthScore | null; burnRate?: BurnRate | null; }>(`/reliability/monitor/${requireMonitorId(monitorId)}`, { days });
        scores = one.healthScore ? [one.healthScore] : [];
        slos = one.burnRate ? [one.burnRate] : [];
    } else {
        const overview = await api.get<{ healthScores?: HealthScore[]; burnRates?: BurnRate[]; }>('/reliability/overview', { days });
        scores = overview.healthScores || [];
        slos = overview.burnRates || [];
    }
    const totalChecks = scores.reduce((sum, score) => sum + (score.total_checks || 0), 0);
    return {
        window_days: days,
        overall_uptime_percentage: totalChecks > 0 ? Number((scores.reduce((sum, score) => sum + score.uptime_percentage * (score.total_checks || 0), 0) / totalChecks).toFixed(3)) : null,
        incident_count: scores.reduce((sum, score) => sum + (score.incident_count || 0), 0),
        monitors: scores.map((score) => ({
            monitor_id: score.monitor_id, monitor_name: score.monitor_name, uptime_percentage: score.uptime_percentage, incident_count: score.incident_count,
            mttr_minutes: score.mttr_minutes, total_checks: score.total_checks, health_score: score.score,
        })),
        slos,
    };
}

export function renderUptimeReport(report: UptimeReport): string {
    if (!report.monitors.length) return `No monitors with data in the last ${report.window_days} days.`;
    const lines = [
        `Uptime, last ${report.window_days} days: ${pct(report.overall_uptime_percentage)} · ${report.incident_count} incidents`,
        '',
        table(report.monitors.map((row) => [
            row.monitor_name, pct(row.uptime_percentage), String(row.incident_count), row.incident_count ? `${Math.round(row.mttr_minutes)}m` : '', String(row.total_checks), String(row.health_score),
        ]), ['MONITOR', 'UPTIME', 'INCIDENTS', 'MTTR', 'CHECKS', 'HEALTH']),
    ];
    if (report.slos.length) {
        lines.push('', table(report.slos.map((slo) => [
            slo.monitor_name, pct(slo.target_percentage), slo.error_budget ? `${slo.error_budget.remaining_percentage}%` : 'n/a',
            `${slo.fast_burn_rate}x / ${slo.slow_burn_rate}x`, slo.is_alerting ? 'burning fast' : slo.error_budget?.exhausted ? 'exhausted' : 'ok',
        ]), ['SLO MONITOR', 'TARGET', 'BUDGET LEFT', 'BURN (FAST/SLOW)', 'STATE']));
    }
    return lines.join('\n');
}

// ─── Incident notes ──────────────────────────────────────────────────────────

export async function addIncidentNote(api: SutramXApi, id: string, body: string, isPublic: boolean): Promise<Record<string, unknown>> {
    requireIncidentId(id);
    const text = body.trim();
    if (!text) throw new Error('The note is empty.');
    if (text.length > 5000) throw new Error('The note is longer than 5000 characters.');
    const result = await api.post<{ note?: Record<string, unknown>; }>(`/incidents/${id}/notes`, { body: text, public: isPublic });
    return (result?.note ?? result) as Record<string, unknown>;
}
