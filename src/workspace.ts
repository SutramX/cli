import type { SutramXApi } from './api.js';
import { ApiError } from './api.js';
import { Manifest, monitorSpecs } from './manifest.js';
import {
    createMonitorResolver,
    IntegrationChange,
    planIntegrations,
    planStatusPages,
    RemoteConnection,
    RemoteStatusPage,
    resolvePageMonitors,
    redactIntegration,
    resolveRouting,
    StatusPageChange,
} from './reconcile.js';

export type MonitorAction = 'create' | 'update' | 'replace' | 'delete' | 'noop';

export interface MonitorChange {
    action: MonitorAction;
    key: string;
    name: string;
    type: string;
    monitor_id: string | null;
    adopted?: boolean;
    changes: Array<{ field: string; from: unknown; to: unknown; }>;
}

export interface MonitorPlanResponse {
    changes: MonitorChange[];
    summary: Record<MonitorAction, number>;
    /** Plan-limit problems apply would hit (older APIs omit it). */
    warnings?: string[];
    /**
     * Identifies exactly this plan. Sent back as expected_fingerprint, apply
     * refuses (409 PLAN_CHANGED) if the workspace changed since. Older APIs
     * omit it.
     */
    plan_fingerprint?: string;
}

/** The workspace changed between plan and apply; nothing was applied. */
export class PlanChangedError extends Error {
    constructor() {
        super('The workspace changed since the plan was shown, so nothing was applied. Run `sutramx apply` again to review the new plan.');
        this.name = 'PlanChangedError';
    }
}

export interface MonitorApplyResult extends MonitorChange {
    status: 'applied' | 'failed' | 'skipped';
    error?: { message: string; code?: string; };
}

export interface WorkspacePlan {
    monitors: MonitorPlanResponse;
    statusPages: StatusPageChange[];
    integrations: IntegrationChange[];
    warnings: string[];
    /** Problems that make apply fail part-way; apply refuses to start while any exist. */
    blockers: string[];
    hasChanges: boolean;
}

export interface PlanOptions {
    prune?: boolean;
    adoptByName?: boolean;
    pruneIntegrations?: boolean;
}

interface RemoteMonitor {
    id: string;
    external_id?: string | null;
    name: string;
}

/**
 * Deleting is never implied by the file: prune and prune_integrations take
 * effect only with --prune / --prune-integrations on the command line (a
 * settings value alone just produces a warning). adopt_by_name may come from
 * the file.
 */
export function effectiveOptions(manifest: Manifest, flags: PlanOptions): Required<PlanOptions> {
    return {
        prune: flags.prune === true,
        adoptByName: flags.adoptByName ?? manifest.settings?.adopt_by_name ?? false,
        pruneIntegrations: flags.pruneIntegrations === true,
    };
}

/** Warnings for delete settings in the file that need a command-line flag. */
export function pruneSettingWarnings(manifest: Manifest, flags: PlanOptions): string[] {
    const warnings: string[] = [];
    if (manifest.settings?.prune && flags.prune === undefined) warnings.push('settings.prune is set in the file, but monitors are only deleted with --prune on the command line');
    if (manifest.settings?.prune_integrations && !flags.pruneIntegrations) warnings.push('settings.prune_integrations is set in the file, but integrations are only deleted with --prune-integrations on the command line');
    return warnings;
}

async function loadStatusPages(api: SutramXApi, manifest: Manifest): Promise<RemoteStatusPage[]> {
    if (!manifest.status_pages?.length) return [];
    const pages = await api.get<RemoteStatusPage[]>('/status/pages/me');
    const declared = new Set(manifest.status_pages.map((page) => page.slug));
    return Promise.all(pages.map(async (page) => (declared.has(page.slug) ? api.get<RemoteStatusPage>(`/status/pages/${encodeURIComponent(page.id)}`) : page)));
}

async function loadConnections(api: SutramXApi, manifest: Manifest): Promise<RemoteConnection[]> {
    if (!manifest.integrations?.length) return [];
    const data = await api.get<{ connections?: RemoteConnection[]; }>('/integrations');
    return data.connections || [];
}

function resolverFor(monitors: RemoteMonitor[], manifest: Manifest, excludeIds: Set<string> = new Set()) {
    return createMonitorResolver(monitors.filter((monitor) => !excludeIds.has(monitor.id)), manifest.monitors.map((monitor) => monitor.key));
}

function warningsFor(statusPages: StatusPageChange[], integrations: IntegrationChange[]): string[] {
    const warnings: string[] = [];
    for (const page of statusPages) {
        if (page.unknownMonitors.length) warnings.push(`status page ${page.slug} references unknown monitor keys: ${page.unknownMonitors.join(', ')} (they will be skipped)`);
    }
    for (const integration of integrations) {
        if (integration.unknownMonitors.length) warnings.push(`integration ${integration.type}/${integration.name} routes to unknown monitor keys: ${integration.unknownMonitors.join(', ')} (they will be skipped)`);
    }
    return warnings;
}

export async function buildPlan(api: SutramXApi, manifest: Manifest, options: Required<PlanOptions>): Promise<WorkspacePlan> {
    const [monitorPlan, remoteMonitors, remotePages, remoteConnections] = await Promise.all([
        api.post<MonitorPlanResponse>('/automation/monitors/plan', { monitors: monitorSpecs(manifest), prune: options.prune, adopt_by_name: options.adoptByName }),
        api.get<RemoteMonitor[]>('/monitors'),
        loadStatusPages(api, manifest),
        loadConnections(api, manifest),
    ]);
    // Monitors being replaced or deleted get new ids (or none) after apply.
    const leaving = new Set(monitorPlan.changes.filter((change) => change.action === 'replace' || change.action === 'delete').map((change) => String(change.monitor_id)));
    const resolver = resolverFor(remoteMonitors, manifest, leaving);
    const statusPages = planStatusPages(manifest.status_pages || [], remotePages, resolver);
    const integrations = planIntegrations(manifest.integrations || [], remoteConnections, resolver, { prune: options.pruneIntegrations });
    const hasChanges = monitorPlan.changes.some((change) => change.action !== 'noop')
        || statusPages.some((change) => change.action !== 'noop')
        || integrations.some((change) => change.action !== 'noop');
    const blockers: string[] = [];
    if (integrations.some((change) => change.action !== 'noop')) {
        // Checked up front: otherwise monitors (and prune deletes) would be
        // applied before the integration step fails with 403.
        const me = await api.get<{ can_manage_alert_channels?: boolean; }>('/automation/whoami');
        if (me.can_manage_alert_channels === false) {
            blockers.push('integrations can only be changed with an API key whose access level is "Automation" (this key is "Standard" or "Read-only")');
        }
    }
    return {
        monitors: monitorPlan,
        statusPages,
        integrations,
        warnings: [...(monitorPlan.warnings || []), ...warningsFor(statusPages, integrations)],
        blockers,
        hasChanges,
    };
}

/** The plan for --json output: integration secrets from the file are masked. */
export function redactedPlan(plan: WorkspacePlan): WorkspacePlan {
    return {
        ...plan,
        integrations: plan.integrations.map((change) => (change.desired ? { ...change, desired: redactIntegration(change.desired) } : change)),
    };
}

export interface StepResult {
    kind: 'monitor' | 'status_page' | 'integration';
    action: string;
    label: string;
    status: 'applied' | 'failed' | 'skipped';
    error?: string;
}

export interface ApplyOutcome {
    ok: boolean;
    steps: StepResult[];
}

function errorText(error: unknown): string {
    return error instanceof ApiError ? `${error.message}${error.code ? ` (${error.code})` : ''}` : (error as Error).message;
}

export interface ApplyOptions extends Required<PlanOptions> {
    continueOnError?: boolean;
    /** plan_fingerprint of the plan the user approved. */
    expectedFingerprint?: string;
    /** Only for APIs without plan fingerprints, after an explicit --force-prune-without-plan-check. */
    allowPruneWithoutFingerprint?: boolean;
}

export async function applyPlan(
    api: SutramXApi,
    manifest: Manifest,
    options: ApplyOptions,
    onStep: (step: StepResult) => void = () => undefined
): Promise<ApplyOutcome> {
    const steps: StepResult[] = [];
    const record = (step: StepResult) => {
        steps.push(step);
        onStep(step);
    };

    // 1. Monitors, server side (same rules as the dashboard).
    let applyResponse: { ok: boolean; results: MonitorApplyResult[]; };
    try {
        applyResponse = await api.post('/automation/monitors/apply', {
            monitors: monitorSpecs(manifest),
            prune: options.prune,
            adopt_by_name: options.adoptByName,
            continue_on_error: options.continueOnError === true,
            ...(options.expectedFingerprint ? { expected_fingerprint: options.expectedFingerprint } : {}),
            ...(options.allowPruneWithoutFingerprint ? { allow_prune_without_fingerprint: true } : {}),
        });
    } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.code === 'PLAN_CHANGED') throw new PlanChangedError();
        record({ kind: 'monitor', action: 'apply', label: 'monitors', status: 'failed', error: errorText(error) });
        return { ok: false, steps };
    }
    for (const result of applyResponse.results) {
        if (result.action === 'noop') continue;
        record({ kind: 'monitor', action: result.action, label: result.key, status: result.status, error: result.error?.message });
    }
    if (!applyResponse.ok && !options.continueOnError) {
        return { ok: false, steps };
    }

    // 2. Integrations and status pages, against fresh monitor ids.
    const [remoteMonitors, remotePages, remoteConnections] = await Promise.all([
        api.get<RemoteMonitor[]>('/monitors'),
        loadStatusPages(api, manifest),
        loadConnections(api, manifest),
    ]);
    const resolver = resolverFor(remoteMonitors, manifest);
    let failed = !applyResponse.ok;

    for (const change of planIntegrations(manifest.integrations || [], remoteConnections, resolver, { prune: options.pruneIntegrations })) {
        if (change.action === 'noop') continue;
        const label = `${change.type}/${change.name}`;
        if (failed && !options.continueOnError) {
            record({ kind: 'integration', action: change.action, label, status: 'skipped' });
            continue;
        }
        try {
            if (change.action === 'delete') {
                await api.delete(`/integrations/connections/${encodeURIComponent(String(change.id))}`);
            } else {
                const integration = change.desired!;
                const { routing } = resolveRouting(integration.routing, resolver);
                const body = { ...integration.config, name: integration.name, routing };
                if (change.action === 'create') await api.post(`/integrations/${encodeURIComponent(integration.type)}/connections`, body);
                else await api.put(`/integrations/connections/${encodeURIComponent(String(change.id))}`, body);
            }
            record({ kind: 'integration', action: change.action, label, status: 'applied' });
        } catch (error) {
            failed = true;
            record({ kind: 'integration', action: change.action, label, status: 'failed', error: errorText(error) });
        }
    }

    for (const change of planStatusPages(manifest.status_pages || [], remotePages, resolver)) {
        if (change.action === 'noop') continue;
        if (failed && !options.continueOnError) {
            record({ kind: 'status_page', action: change.action, label: change.slug, status: 'skipped' });
            continue;
        }
        try {
            const page = change.desired;
            let id = change.id;
            if (change.action === 'create') {
                const created = await api.post<RemoteStatusPage>('/status/pages', {
                    title: page.title,
                    ...(page.description !== undefined ? { description: page.description } : {}),
                    ...(page.is_public !== undefined ? { is_public: page.is_public } : {}),
                });
                id = created.id;
            }
            const patch: Record<string, unknown> = {};
            for (const field of ['title', 'description', 'is_public', 'logo_url', 'accent_color', 'favicon_url', 'show_response_times', 'hide_powered_by'] as const) {
                if (page[field] !== undefined && (change.action === 'create' ? !['title', 'description', 'is_public'].includes(field) : change.changes.some((diff) => diff.field === field))) {
                    patch[field] = page[field];
                }
            }
            if (change.action === 'create') {
                patch.slug = page.slug;
                try {
                    await api.patch(`/status/pages/${encodeURIComponent(String(id))}`, patch);
                } catch (error) {
                    // Pages are matched by slug: one left with a generated slug
                    // would be created again on every apply.
                    await api.delete(`/status/pages/${encodeURIComponent(String(id))}`).catch(() => undefined);
                    throw error;
                }
            } else if (Object.keys(patch).length) {
                await api.patch(`/status/pages/${encodeURIComponent(String(id))}`, patch);
            }
            if (page.monitors !== undefined && (change.action === 'create' || change.changes.some((diff) => diff.field === 'monitors'))) {
                const { entries } = resolvePageMonitors(page, resolver);
                const monitors = entries.filter((entry) => entry.monitor_id).map((entry) => ({ monitor_id: entry.monitor_id!, section: entry.section }));
                await api.put(`/status/pages/${encodeURIComponent(String(id))}/monitors`, { monitors });
            }
            record({ kind: 'status_page', action: change.action, label: change.slug, status: 'applied' });
        } catch (error) {
            failed = true;
            record({ kind: 'status_page', action: change.action, label: change.slug, status: 'failed', error: errorText(error) });
        }
    }

    return { ok: !failed, steps };
}
