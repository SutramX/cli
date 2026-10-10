import { ApiError, type SutramXApi } from './api.js';
import { formatDuration, UUID } from './operations.js';
import { bold, clean, cyan, dim, green, red, table, yellow } from './render.js';

/**
 * `sutramx why <monitor|incident-id>`: the dashboard's "Why this alert" in
 * the terminal. Same API and result shape as the MCP server's
 * sutramx_explain_incident; deterministic, from recorded checks.
 *
 *   GET /incidents/:id/explanation  one incident
 *   GET /monitors/:id/explanation   the open incident, or the monitor's current per-region state
 *   GET /monitors/:id/flakiness     7/30-day flakiness score
 *   GET /incidents?monitor_id=      the most recent incident when nothing is open
 */

export const MAX_CANDIDATES = 10;

export type WhyOutcome = 'ongoing' | 'resolved' | 'healthy' | 'failing_unconfirmed' | 'no_data' | 'paused' | 'ambiguous';

interface ApiVote {
    region: string;
    region_name: string;
    status: string;
    checked_at: string | null;
    error_type: string | null;
    failure_class: string | null;
    http_status: number | null;
    message: string | null;
    timings: { total_ms?: number; } | null;
    confirming: boolean;
}

interface ApiContributor { kind: string; title: string; detail: string; severity: string; source: string; data?: unknown; }

/** GET /incidents/:id/explanation, GET /monitors/:id/explanation (fields read here). */
export interface ApiExplanation {
    subject: 'incident' | 'monitor';
    state: 'ongoing' | 'resolved' | 'failing_unconfirmed' | 'healthy' | 'no_data';
    monitor: { id: string; name: string; type: string; url: string | null; };
    incident_id: string | null;
    opened_at: string | null;
    resolved_at: string | null;
    evaluated_at: string;
    verdict: string;
    fault: string;
    fault_reason: string;
    is_flapping: boolean;
    votes: ApiVote[];
    quorum: {
        rule: string; required: number | null; considered: number | null; agreeing: number; met: boolean; abstaining: string[];
        reduced_coverage: { missing_regions: string[]; usual_quorum: number | null; } | null;
        confirmation: { state: string; summary: string; } | null;
    };
    failure: { class: string | null; label: string; scope: string; failing_regions: string[]; passing_regions: string[]; };
    alert: { notified: boolean; status: string; reason: string | null; detail: string; } | null;
    contributors: ApiContributor[];
}

interface ApiFlakinessWindow { score: number | null; level: string; label: string; total_checks: number; reasons?: Array<{ kind: string; label: string; }>; }
export interface ApiFlakiness { monitor_id: string; windows: { '7d': ApiFlakinessWindow; '30d': ApiFlakinessWindow; }; }

export interface RegionVoteView {
    region: string;
    region_name: string;
    outcome: string;
    abstained: boolean;
    confirming: boolean;
    failure_class: string | null;
    error_type: string | null;
    http_status: number | null;
    latency_ms: number | null;
    checked_at: string | null;
    message: string | null;
}

export interface VendorSignalView {
    vendor_id: string | null;
    vendor_name: string | null;
    title: string;
    detail: string;
    confidence: string;
    likely_cause: boolean;
    /** Privacy-safe bucket of affected SutramX accounts ('several' / 'many'). */
    affected_accounts: string | null;
    status: string | null;
    source: string;
    started_at: string | null;
    ended_at: string | null;
    status_page_url: string | null;
}

export interface ExplanationView {
    subject: string;
    state: string;
    incident_id: string | null;
    monitor: { id: string; name: string; type: string; url: string | null; };
    opened_at: string | null;
    resolved_at: string | null;
    duration_seconds: number | null;
    evaluated_at: string;
    verdict: string;
    fault: string;
    fault_reason: string;
    is_flapping: boolean;
    failure: ApiExplanation['failure'];
    quorum: { rule: string; required: number | null; considered: number | null; agreeing: number; met: boolean; abstaining: string[]; reduced_coverage: ApiExplanation['quorum']['reduced_coverage']; confirmation: { state: string; summary: string; } | null; };
    regions: RegionVoteView[];
    vendor: VendorSignalView[];
    other_findings: Array<{ kind: string; title: string; detail: string; severity: string; source: string; }>;
    alert: { notified: boolean; status: string; reason: string | null; detail: string; } | null;
}

type FlakinessWindowView = { score: number | null; level: string; label: string; total_checks: number; reasons: string[]; } | null;
export interface FlakinessView { '7d': FlakinessWindowView; '30d': FlakinessWindowView; }

export interface MonitorView { id: string; name: string; type: string; url: string | null; key: string | null; status: string | null; paused: boolean; }

export interface WhyResult {
    outcome: WhyOutcome;
    summary: string;
    monitor: MonitorView | null;
    explanation: ExplanationView | null;
    last_incident: ExplanationView | null;
    incidents_total: number | null;
    in_maintenance: boolean;
    flakiness: FlakinessView | null;
    candidates?: MonitorView[];
    notes?: string[];
}

// ─── shaping ─────────────────────────────────────────────────────────────────

const ABSTAINING = new Set(['blocked', 'inconclusive', 'unknown']);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export function explanationView(raw: ApiExplanation): ExplanationView {
    const opened = raw.opened_at ? Date.parse(raw.opened_at) : Number.NaN;
    const resolved = raw.resolved_at ? Date.parse(raw.resolved_at) : Number.NaN;
    const contributors = Array.isArray(raw.contributors) ? raw.contributors : [];
    const quorum = raw.quorum ?? ({} as ApiExplanation['quorum']);
    const failure = raw.failure ?? ({} as ApiExplanation['failure']);
    return {
        subject: raw.subject,
        state: raw.state,
        incident_id: raw.incident_id ?? null,
        monitor: { id: String(raw.monitor?.id ?? ''), name: String(raw.monitor?.name ?? ''), type: String(raw.monitor?.type ?? ''), url: raw.monitor?.url ?? null },
        opened_at: raw.opened_at ?? null,
        resolved_at: raw.resolved_at ?? null,
        duration_seconds: Number.isFinite(opened) && Number.isFinite(resolved) ? Math.max(0, Math.round((resolved - opened) / 1000)) : null,
        evaluated_at: raw.evaluated_at,
        verdict: String(raw.verdict ?? ''),
        fault: String(raw.fault ?? 'unknown'),
        fault_reason: String(raw.fault_reason ?? ''),
        is_flapping: raw.is_flapping === true,
        failure: {
            class: failure.class ?? null,
            label: String(failure.label ?? ''),
            scope: String(failure.scope ?? 'none'),
            failing_regions: Array.isArray(failure.failing_regions) ? failure.failing_regions : [],
            passing_regions: Array.isArray(failure.passing_regions) ? failure.passing_regions : [],
        },
        quorum: {
            rule: String(quorum.rule ?? ''),
            required: num(quorum.required),
            considered: num(quorum.considered),
            agreeing: num(quorum.agreeing) ?? 0,
            met: quorum.met === true,
            abstaining: Array.isArray(quorum.abstaining) ? quorum.abstaining : [],
            reduced_coverage: quorum.reduced_coverage ?? null,
            confirmation: quorum.confirmation ? { state: quorum.confirmation.state, summary: quorum.confirmation.summary } : null,
        },
        regions: (Array.isArray(raw.votes) ? raw.votes : []).map((vote) => ({
            region: vote.region,
            region_name: vote.region_name || vote.region,
            outcome: vote.status,
            abstained: ABSTAINING.has(vote.status),
            confirming: vote.confirming === true,
            failure_class: vote.failure_class ?? null,
            error_type: vote.error_type ?? null,
            http_status: num(vote.http_status),
            latency_ms: num(vote.timings?.total_ms),
            checked_at: vote.checked_at ?? null,
            message: vote.message ?? null,
        })),
        vendor: contributors.filter((item) => item.kind === 'vendor').map((item) => {
            const data = record(item.data);
            const official = record(data.official);
            return {
                vendor_id: str(data.vendor_id),
                vendor_name: str(data.vendor_name),
                title: String(item.title ?? ''),
                detail: String(item.detail ?? ''),
                confidence: String(item.severity ?? 'info'),
                likely_cause: item.severity === 'likely_cause',
                affected_accounts: str(data.customers),
                status: str(data.status),
                source: String(item.source ?? ''),
                started_at: str(data.started_at) ?? str(official.reported_at),
                ended_at: str(data.ended_at),
                status_page_url: str(official.status_page_url),
            };
        }),
        other_findings: contributors.filter((item) => item.kind !== 'vendor').map((item) => ({
            kind: String(item.kind), title: String(item.title ?? ''), detail: String(item.detail ?? ''), severity: String(item.severity ?? 'info'), source: String(item.source ?? ''),
        })),
        alert: raw.alert ? { notified: raw.alert.notified === true, status: raw.alert.status, reason: raw.alert.reason ?? null, detail: String(raw.alert.detail ?? '') } : null,
    };
}

export function flakinessView(raw: ApiFlakiness | null): FlakinessView | null {
    if (!raw?.windows) return null;
    const window = (value: ApiFlakinessWindow | undefined): FlakinessWindowView => (value
        ? { score: num(value.score), level: String(value.level), label: String(value.label ?? ''), total_checks: num(value.total_checks) ?? 0, reasons: (value.reasons || []).map((reason) => String(reason.label ?? reason.kind)) }
        : null);
    return { '7d': window(raw.windows['7d']), '30d': window(raw.windows['30d']) };
}

export function monitorView(monitor: Record<string, any>): MonitorView {
    const paused = monitor.is_active === false || monitor.current_status === 'paused';
    return {
        id: String(monitor.id), name: String(monitor.name ?? ''), type: String(monitor.type ?? ''), url: monitor.url ?? null, key: monitor.external_id ?? null,
        status: monitor.current_status ?? (paused ? 'paused' : null), paused,
    };
}

export type MonitorMatch = { kind: 'one'; monitor: Record<string, any>; } | { kind: 'none'; } | { kind: 'many'; candidates: Array<Record<string, any>>; };

/** id, then sutramx.yml key, then exact name (case-insensitive), then a name / URL substring; ties are ambiguous. */
export function matchMonitors(monitors: Array<Record<string, any>>, text: string): MonitorMatch {
    const needle = text.trim().toLowerCase();
    if (!needle) return { kind: 'none' };
    const tiers: Array<(monitor: Record<string, any>) => boolean> = [
        (monitor) => String(monitor.id).toLowerCase() === needle,
        (monitor) => typeof monitor.external_id === 'string' && monitor.external_id.toLowerCase() === needle,
        (monitor) => String(monitor.name ?? '').trim().toLowerCase() === needle,
        (monitor) => String(monitor.name ?? '').toLowerCase().includes(needle) || String(monitor.url ?? '').toLowerCase().includes(needle),
    ];
    for (const tier of tiers) {
        const found = monitors.filter(tier);
        if (found.length === 1) return { kind: 'one', monitor: found[0] };
        if (found.length > 1) return { kind: 'many', candidates: found };
    }
    return { kind: 'none' };
}

// ─── summary ─────────────────────────────────────────────────────────────────

export function time(value: unknown): string {
    if (!value) return 'never';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? clean(value) : date.toISOString().replace('T', ' ').replace(/:\d{2}\.\d+Z$/, 'Z');
}

function duration(seconds: number | null): string {
    if (seconds != null && seconds >= 86_400) return `${(seconds / 86_400).toFixed(1)}d`;
    return formatDuration(seconds);
}

function sentence(text: string): string {
    const trimmed = text.trim();
    return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lastIncidentClause(result: Pick<WhyResult, 'last_incident' | 'incidents_total'>): string {
    if (result.last_incident) {
        const last = result.last_incident;
        return ` Last incident ${time(last.opened_at)}${last.resolved_at ? `, resolved after ${duration(last.duration_seconds)}` : ''}: ${sentence(last.verdict)}`;
    }
    return result.incidents_total === 0 ? ' No incidents recorded for this monitor.' : '';
}

export function summaryLine(result: Omit<WhyResult, 'summary'>): string {
    const name = result.monitor?.name ?? result.explanation?.monitor.name ?? 'The monitor';
    const maintenance = result.in_maintenance ? ' A maintenance window is active: alerts are silenced.' : '';
    const explanation = result.explanation;
    switch (result.outcome) {
        case 'ambiguous':
            return `${(result.candidates || []).length} monitors match; pass the monitor id (or its exact name or key).`;
        case 'paused':
            return `${name} is paused: no checks run, so it cannot be down.${lastIncidentClause(result)}`;
        case 'ongoing':
            return `${name} is DOWN since ${time(explanation?.opened_at)} (incident ${explanation?.incident_id}): ${sentence(explanation?.verdict ?? '')}${maintenance}`;
        case 'resolved':
            return `${name} incident ${explanation?.incident_id} (${time(explanation?.opened_at)}, resolved after ${duration(explanation?.duration_seconds ?? null)}): ${sentence(explanation?.verdict ?? '')}`;
        case 'failing_unconfirmed':
            return `${name} has failing checks but no incident: ${sentence(explanation?.verdict ?? '')}${maintenance}${lastIncidentClause(result)}`;
        case 'no_data':
            return `${name} has no recent checks to explain.${maintenance}${lastIncidentClause(result)}`;
        case 'healthy':
        default:
            return `${name} is up, no open incident: ${sentence(explanation?.verdict ?? '')}${maintenance}${lastIncidentClause(result)}`;
    }
}

// ─── fetching ────────────────────────────────────────────────────────────────

function noteOf(what: string, error: unknown): string {
    return `${what} could not be loaded: ${error instanceof ApiError ? `HTTP ${error.status}${error.code ? ` ${error.code}` : ''}` : (error as Error)?.message || String(error)}`;
}

async function optional<T>(work: Promise<T>, what: string, notes: string[]): Promise<T | null> {
    try {
        return await work;
    } catch (error) {
        notes.push(noteOf(what, error));
        return null;
    }
}

function finish(partial: Omit<WhyResult, 'summary'>): WhyResult {
    const result: WhyResult = { ...partial, summary: summaryLine(partial) };
    if (!result.notes?.length) delete result.notes;
    return result;
}

async function explainMonitor(api: SutramXApi, monitor: Record<string, any>, includeLastIncident: boolean): Promise<WhyResult> {
    const notes: string[] = [];
    const view = monitorView(monitor);
    if (!UUID.test(view.id)) throw new Error('The API returned a monitor without a valid id.');
    const flakinessWork = optional(api.get<ApiFlakiness>(`/monitors/${view.id}/flakiness`), 'Flakiness', notes);
    const explanation = view.paused ? null : explanationView(await api.get<ApiExplanation>(`/monitors/${view.id}/explanation`));
    let lastIncident: ExplanationView | null = null;
    let incidentsTotal: number | null = null;
    if (explanation?.subject !== 'incident' && includeLastIncident) {
        const list = await optional(api.get<{ items: Array<{ id: string; }>; total: number; }>('/incidents', { monitor_id: view.id, status: 'all', page: 1, page_size: 1 }), 'The most recent incident', notes);
        if (list) {
            incidentsTotal = typeof list.total === 'number' ? list.total : (list.items || []).length;
            const latest = (list.items || [])[0];
            if (latest && UUID.test(String(latest.id))) {
                const raw = await optional(api.get<ApiExplanation>(`/incidents/${latest.id}/explanation`), 'The most recent incident', notes);
                if (raw) lastIncident = explanationView(raw);
            }
        }
    }
    return finish({
        outcome: view.paused ? 'paused' : explanation!.state as WhyOutcome,
        monitor: view,
        explanation,
        last_incident: lastIncident,
        incidents_total: incidentsTotal,
        in_maintenance: monitor.current_status === 'maintenance',
        flakiness: flakinessView(await flakinessWork),
        notes,
    });
}

async function explainIncident(api: SutramXApi, raw: ApiExplanation): Promise<WhyResult> {
    const notes: string[] = [];
    const explanation = explanationView(raw);
    let monitor: Record<string, any> | null = null;
    let flakiness: ApiFlakiness | null = null;
    if (UUID.test(explanation.monitor.id)) {
        [monitor, flakiness] = await Promise.all([
            optional(api.get<Record<string, any>>(`/monitors/${explanation.monitor.id}`), 'The monitor', notes),
            optional(api.get<ApiFlakiness>(`/monitors/${explanation.monitor.id}/flakiness`), 'Flakiness', notes),
        ]);
    }
    return finish({
        outcome: explanation.state === 'ongoing' ? 'ongoing' : 'resolved',
        monitor: monitor ? monitorView(monitor) : { ...explanation.monitor, key: null, status: null, paused: false },
        explanation,
        last_incident: null,
        incidents_total: null,
        in_maintenance: monitor?.current_status === 'maintenance',
        flakiness: flakinessView(flakiness),
        notes,
    });
}

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * A UUID is tried as an incident first, then as a monitor; anything else is
 * matched against the workspace's monitors (key, name, URL).
 */
export async function why(api: SutramXApi, target: string, options: { lastIncident?: boolean; } = {}): Promise<WhyResult> {
    const includeLastIncident = options.lastIncident !== false;
    const text = String(target ?? '').trim();
    if (!text) throw new Error('Pass a monitor (id, key or name) or an incident id.');
    if (text.length > 200) throw new Error('The monitor name is longer than 200 characters.');
    if (UUID.test(text)) {
        try {
            return await explainIncident(api, await api.get<ApiExplanation>(`/incidents/${text}/explanation`));
        } catch (error) {
            if (!notFound(error)) throw error;
        }
        try {
            return await explainMonitor(api, await api.get<Record<string, any>>(`/monitors/${text}`), includeLastIncident);
        } catch (error) {
            if (notFound(error)) throw new Error(`No incident or monitor with id ${text} in this workspace; see \`sutramx incidents list\` or \`sutramx monitors list\`.`);
            throw error;
        }
    }
    const list = await api.get<Array<Record<string, any>>>('/monitors');
    const match = matchMonitors(Array.isArray(list) ? list : [], text);
    if (match.kind === 'none') throw new Error(`No monitor matches "${clean(text)}" (searched keys, names and URLs); see \`sutramx monitors list\`.`);
    if (match.kind === 'many') {
        return finish({
            outcome: 'ambiguous', monitor: null, explanation: null, last_incident: null, incidents_total: null, in_maintenance: false, flakiness: null,
            candidates: match.candidates.slice(0, MAX_CANDIDATES).map(monitorView),
            notes: match.candidates.length > MAX_CANDIDATES ? [`${match.candidates.length} monitors match; the first ${MAX_CANDIDATES} are listed.`] : [],
        });
    }
    return explainMonitor(api, match.monitor, includeLastIncident);
}

// ─── rendering ───────────────────────────────────────────────────────────────

const FAULT: Record<string, (text: string) => string> = { yours: red, external: yellow, checker: cyan, unknown: dim };
const FAULT_TEXT: Record<string, string> = {
    yours: 'your side (the regional quorum confirmed it; no external cause found)',
    external: 'likely external',
    checker: 'likely our checker, not your site',
    unknown: '',
};

function outcomeColour(outcome: string): (text: string) => string {
    if (outcome === 'down' || outcome === 'ongoing') return red;
    if (outcome === 'up' || outcome === 'healthy' || outcome === 'resolved') return green;
    if (outcome === 'blocked' || outcome === 'inconclusive' || outcome === 'failing_unconfirmed') return yellow;
    return dim;
}

function regionTable(regions: RegionVoteView[]): string {
    const rows = regions.map((vote) => [
        `${vote.region_name} (${vote.region})`,
        vote.abstained ? `${vote.outcome} (abstains)` : vote.outcome,
        vote.failure_class ?? '',
        vote.http_status == null ? '' : String(vote.http_status),
        vote.latency_ms == null ? '' : String(vote.latency_ms),
        vote.confirming ? 'yes' : '',
        clean(vote.message ?? '').replace(/\s+/g, ' ').slice(0, 80),
    ]);
    return table(rows, ['REGION', 'VOTE', 'CLASS', 'HTTP', 'MS', 'CONFIRMED', 'ERROR'])
        .replace(/ (up|down|blocked|inconclusive|unknown)( \(abstains\))? /g, (match, outcome, abstains) => ` ${outcomeColour(outcome)(`${outcome}${abstains ?? ''}`)} `);
}

function explanationLines(view: ExplanationView, heading: string): string[] {
    const quorum = view.quorum;
    const fault = FAULT[view.fault] ?? dim;
    const counts = quorum.required != null ? dim(` (${quorum.agreeing} agreeing, ${quorum.required} required${quorum.considered != null ? `, ${quorum.considered} counted` : ''})`) : '';
    const lines = [
        bold(heading),
        `  verdict   ${clean(view.verdict)}`,
        `  fault     ${fault(clean(view.fault))}${FAULT_TEXT[view.fault] ? `: ${FAULT_TEXT[view.fault]}` : ''}${view.fault_reason ? dim(` · ${clean(view.fault_reason)}`) : ''}`,
        `  failure   ${clean(view.failure.label || 'none')}${view.failure.class ? dim(` (${clean(view.failure.class)})`) : ''} · ${clean(view.failure.scope).replace(/_/g, ' ')}`,
        `  quorum    ${clean(quorum.rule || 'n/a')}: ${quorum.met ? green('met') : yellow('not met')}${counts}${quorum.abstaining.length ? dim(` · abstaining: ${quorum.abstaining.map(clean).join(', ')}`) : ''}`,
    ];
    if (quorum.reduced_coverage) lines.push(`  coverage  reduced: ${quorum.reduced_coverage.missing_regions.map(clean).join(', ')} unavailable`);
    if (quorum.confirmation && quorum.confirmation.state !== 'none') lines.push(`  verified  ${clean(quorum.confirmation.state)}: ${clean(quorum.confirmation.summary)}`);
    if (view.incident_id) {
        lines.push(`  incident  ${clean(view.incident_id)} opened ${time(view.opened_at)}${view.resolved_at ? `, resolved ${time(view.resolved_at)} (after ${duration(view.duration_seconds)})` : `, ${red('ongoing')}`}${view.is_flapping ? yellow(' · flapping') : ''}`);
    }
    if (view.alert) lines.push(`  alert     ${clean(view.alert.status)}${view.alert.reason ? ` (${clean(view.alert.reason)})` : ''}: ${clean(view.alert.detail)}`);
    if (view.regions.length) lines.push('', ...regionTable(view.regions).split('\n').map((line) => `  ${line}`));
    for (const vendor of view.vendor) {
        const accounts = vendor.affected_accounts ? dim(` (seen by ${clean(vendor.affected_accounts)} SutramX accounts)`) : '';
        lines.push('', `  ${vendor.likely_cause ? yellow('likely cause') : dim('related')}  ${clean(vendor.title)}${accounts}`, `                ${dim(clean(vendor.detail).replace(/\s+/g, ' ').slice(0, 400))}`);
    }
    for (const finding of view.other_findings) {
        lines.push('', `  ${finding.severity === 'likely_cause' ? yellow('likely cause') : dim(clean(finding.kind))}  ${clean(finding.title)}`, `                ${dim(clean(finding.detail).replace(/\s+/g, ' ').slice(0, 400))}`);
    }
    return lines;
}

export function renderWhy(result: WhyResult): string {
    if (result.outcome === 'ambiguous') {
        const body = table((result.candidates || []).map((candidate) => [candidate.id, candidate.key ?? '', candidate.name, candidate.type, candidate.status ?? '', candidate.url ?? '']), ['ID', 'KEY', 'NAME', 'TYPE', 'STATUS', 'TARGET']);
        return [yellow(clean(result.summary)), '', body, ...(result.notes || []).map((note) => dim(clean(note)))].join('\n');
    }
    const lines = [outcomeColour(result.outcome)(bold(clean(result.summary)))];
    if (result.monitor) {
        lines.push(dim(`monitor ${clean(result.monitor.id)} [${clean(result.monitor.type)}]${result.monitor.key ? ` key ${clean(result.monitor.key)}` : ''}${result.monitor.url ? ` ${clean(result.monitor.url)}` : ''}${result.monitor.status ? ` · ${clean(result.monitor.status)}` : ''}${result.in_maintenance ? ' · in maintenance' : ''}`));
    }
    if (result.explanation) {
        const heading = result.explanation.subject === 'incident'
            ? (result.explanation.resolved_at ? 'Incident (resolved)' : 'Open incident')
            : 'Now (no open incident)';
        lines.push('', ...explanationLines(result.explanation, heading));
    }
    if (result.last_incident) lines.push('', ...explanationLines(result.last_incident, 'Most recent incident'));
    if (result.flakiness) {
        const window = (label: string, value: FlakinessWindowView) => (value ? `${label} ${value.score ?? 'n/a'}/100 ${clean(value.label || value.level)}` : `${label} n/a`);
        lines.push('', `${bold('Flakiness')}  ${window('7d', result.flakiness['7d'])} · ${window('30d', result.flakiness['30d'])}`);
    }
    for (const note of result.notes || []) lines.push(dim(`Note: ${clean(note)}`));
    return lines.join('\n');
}
