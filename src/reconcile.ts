import type { ManifestIntegration, ManifestStatusPage } from './manifest.js';

/**
 * Client-side plans for status pages and integrations (monitors are planned
 * by the API: POST /automation/monitors/plan). Pure functions; the apply
 * step lives in workspace.ts.
 *
 * Status pages are matched by slug and never deleted by apply (a page has
 * public subscribers; delete it in the dashboard). Integrations are matched
 * by type + name; secrets are stored encrypted and only read back masked,
 * so a secret counts as changed when its visible tail differs.
 */

export interface FieldDiff {
    field: string;
    from: unknown;
    to: unknown;
}

export interface RemoteStatusPage {
    id: string;
    slug: string;
    title: string;
    description?: string | null;
    is_public?: boolean;
    logo_url?: string | null;
    accent_color?: string | null;
    favicon_url?: string | null;
    show_response_times?: boolean;
    is_whitelabel?: boolean;
    monitors?: Array<{ id: string; section: string | null; }>;
}

export interface StatusPageChange {
    action: 'create' | 'update' | 'noop';
    slug: string;
    title: string;
    id: string | null;
    changes: FieldDiff[];
    /** Monitor keys the page references that are not declared and do not exist. */
    unknownMonitors: string[];
    desired: ManifestStatusPage;
}

export interface RemoteConnection {
    id: string;
    integration_type: string;
    name: string;
    config: Record<string, unknown>;
    routing?: { scope: string; group_ids?: string[]; monitor_ids?: string[]; };
}

export interface IntegrationChange {
    action: 'create' | 'update' | 'delete' | 'noop';
    type: string;
    name: string;
    id: string | null;
    changes: FieldDiff[];
    unknownMonitors: string[];
    desired?: ManifestIntegration;
}

/** Key → monitor id for existing monitors; keys being created resolve after apply. */
export interface MonitorResolver {
    idFor(keyOrId: string): string | null;
    /** Declared in the file (it may not exist yet). */
    isDeclared(key: string): boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMonitorResolver(remote: Array<{ id: string; external_id?: string | null; }>, declaredKeys: Iterable<string>): MonitorResolver {
    const byKey = new Map(remote.filter((monitor) => monitor.external_id).map((monitor) => [String(monitor.external_id), monitor.id]));
    const ids = new Set(remote.map((monitor) => monitor.id));
    const declared = new Set(declaredKeys);
    return {
        idFor: (keyOrId) => byKey.get(keyOrId) ?? (UUID.test(keyOrId) && ids.has(keyOrId) ? keyOrId : null),
        isDeclared: (key) => declared.has(key),
    };
}

function pageMonitorEntries(page: ManifestStatusPage): Array<{ key: string; section: string | null; }> {
    return (page.monitors || []).map((entry) => (typeof entry === 'string' ? { key: entry, section: null } : { key: entry.key, section: entry.section ?? null }));
}

/** The {monitor_id, section} list a page should have; null ids are monitors still to be created. */
export function resolvePageMonitors(page: ManifestStatusPage, resolver: MonitorResolver) {
    const unknown: string[] = [];
    const entries = pageMonitorEntries(page).map((entry) => {
        const id = resolver.idFor(entry.key);
        if (!id && !resolver.isDeclared(entry.key)) unknown.push(entry.key);
        return { key: entry.key, monitor_id: id, section: entry.section };
    });
    return { entries, unknown };
}

const PAGE_FIELDS: Array<[keyof ManifestStatusPage, keyof RemoteStatusPage]> = [
    ['title', 'title'],
    ['description', 'description'],
    ['is_public', 'is_public'],
    ['logo_url', 'logo_url'],
    ['accent_color', 'accent_color'],
    ['favicon_url', 'favicon_url'],
    ['show_response_times', 'show_response_times'],
    ['hide_powered_by', 'is_whitelabel'],
];

function norm(value: unknown): unknown {
    return value === '' || value === undefined ? null : value;
}

export function planStatusPages(desired: ManifestStatusPage[], remote: RemoteStatusPage[], resolver: MonitorResolver): StatusPageChange[] {
    const bySlug = new Map(remote.map((page) => [page.slug, page]));
    return desired.map((page) => {
        const current = bySlug.get(page.slug) || null;
        const { entries, unknown } = resolvePageMonitors(page, resolver);
        const changes: FieldDiff[] = [];
        for (const [field, remoteField] of PAGE_FIELDS) {
            if (page[field] === undefined) continue;
            const from = current ? norm(current[remoteField]) : null;
            const to = norm(page[field]);
            if (!current || JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
        }
        if (page.monitors !== undefined) {
            const currentList = (current?.monitors || []).map((monitor) => `${monitor.id}|${monitor.section ?? ''}`);
            const desiredList = entries.map((entry) => `${entry.monitor_id ?? `new:${entry.key}`}|${entry.section ?? ''}`);
            if (!current || JSON.stringify(currentList) !== JSON.stringify(desiredList)) {
                changes.push({ field: 'monitors', from: current ? (current.monitors || []).length : null, to: entries.map((entry) => entry.key) });
            }
        }
        const action = !current ? 'create' : changes.length ? 'update' : 'noop';
        return { action, slug: page.slug, title: page.title, id: current?.id ?? null, changes, unknownMonitors: unknown, desired: page };
    });
}

/**
 * True when the desired value could be what the API shows masked
 * ("…abcd" or "https://host/…abcd"). Unmasked values compare exactly.
 */
export function matchesMasked(desired: string, shown: unknown): boolean {
    if (typeof shown !== 'string') return false;
    const ellipsis = shown.lastIndexOf('…');
    if (ellipsis < 0) return desired === shown;
    const prefix = shown.slice(0, ellipsis).replace(/\/$/, '');
    const tail = shown.slice(ellipsis + 1);
    return desired.endsWith(tail) && (!prefix || desired.startsWith(prefix));
}

/** The routing body the API expects, from manifest routing (monitor keys resolved). */
export interface RoutingBody {
    scope: 'all' | 'monitors';
    monitor_ids?: string[];
}

export function resolveRouting(routing: ManifestIntegration['routing'], resolver: MonitorResolver): { routing: RoutingBody; unknown: string[]; pending: boolean; } {
    const unknown: string[] = [];
    if (!routing || routing.scope === 'all') return { routing: { scope: 'all' }, unknown, pending: false };
    let pending = false;
    const ids: string[] = [];
    for (const key of routing.monitors || []) {
        const id = resolver.idFor(key);
        if (id) ids.push(id);
        else if (resolver.isDeclared(key)) pending = true;
        else unknown.push(key);
    }
    return { routing: { scope: 'monitors', monitor_ids: ids }, unknown, pending };
}

export function planIntegrations(
    desired: ManifestIntegration[],
    remote: RemoteConnection[],
    resolver: MonitorResolver,
    options: { prune?: boolean; } = {}
): IntegrationChange[] {
    const keyOf = (type: string, name: string) => `${type}/${name}`;
    const byKey = new Map(remote.map((connection) => [keyOf(connection.integration_type, connection.name), connection]));
    const plan: IntegrationChange[] = desired.map((integration) => {
        const current = byKey.get(keyOf(integration.type, integration.name)) || null;
        const { routing, unknown, pending } = resolveRouting(integration.routing, resolver);
        if (!current) {
            return { action: 'create', type: integration.type, name: integration.name, id: null, changes: [], unknownMonitors: unknown, desired: integration };
        }
        const changes: FieldDiff[] = [];
        for (const [field, value] of Object.entries(integration.config)) {
            const desiredValue = String(value);
            if (!matchesMasked(desiredValue, current.config?.[field])) {
                const shown = current.config?.[field];
                changes.push({ field: `config.${field}`, from: shown ?? null, to: typeof shown === 'string' && shown.includes('…') ? '(new secret)' : desiredValue });
            }
        }
        const currentScope = current.routing?.scope || 'all';
        const currentIds = [...(current.routing?.monitor_ids || [])].sort();
        const desiredIds = [...(routing.monitor_ids || [])].sort();
        if (currentScope !== routing.scope || pending || JSON.stringify(currentIds) !== JSON.stringify(desiredIds)) {
            changes.push({ field: 'routing', from: currentScope === 'all' ? 'all' : currentIds, to: routing.scope === 'all' ? 'all' : integration.routing?.monitors });
        }
        return {
            action: changes.length ? 'update' : 'noop',
            type: integration.type,
            name: integration.name,
            id: current.id,
            changes,
            unknownMonitors: unknown,
            desired: integration,
        };
    });
    if (options.prune) {
        const declaredTypes = new Set(desired.map((integration) => integration.type));
        const declared = new Set(desired.map((integration) => keyOf(integration.type, integration.name)));
        for (const connection of remote) {
            // Only types the file manages: a Slack-only file never removes PagerDuty.
            if (!declaredTypes.has(connection.integration_type) || declared.has(keyOf(connection.integration_type, connection.name))) continue;
            plan.unshift({ action: 'delete', type: connection.integration_type, name: connection.name, id: connection.id, changes: [], unknownMonitors: [] });
        }
    }
    return plan;
}
