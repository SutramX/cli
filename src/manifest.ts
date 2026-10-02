import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * sutramx.yml: the declarative description of a workspace's monitors, status
 * pages and alert channels. Field-level monitor rules (intervals, config,
 * regions, plan limits) are validated by the API during `plan`, so new
 * monitor types work without a CLI upgrade; this module checks structure,
 * expands ${ENV} references and applies `defaults`.
 */

export const MANIFEST_VERSION = 1;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const MonitorSchema = z.object({
    key: z.string().regex(KEY, 'key: letters, digits and . _ : / - (1-128 characters, starting with a letter or digit)'),
    name: z.string().min(1).max(255),
    type: z.string().min(2).max(32).optional(),
    url: z.string().max(2048).optional(),
    interval_seconds: z.number().int().positive().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
    regions: z.union([z.array(z.string()).min(1), z.null()]).optional(),
    paused: z.boolean().optional(),
}).strict();

const StatusPageMonitorSchema = z.union([
    z.string().regex(KEY),
    z.object({ key: z.string().regex(KEY), section: z.string().max(100).nullable().optional() }).strict(),
]);

const StatusPageSchema = z.object({
    slug: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/, 'slug: lowercase letters, digits and hyphens'),
    title: z.string().min(1).max(255),
    description: z.string().max(1000).nullable().optional(),
    is_public: z.boolean().optional(),
    logo_url: z.string().max(2048).nullable().optional(),
    accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    favicon_url: z.string().max(2048).nullable().optional(),
    show_response_times: z.boolean().optional(),
    hide_powered_by: z.boolean().optional(),
    monitors: z.array(StatusPageMonitorSchema).max(500).optional(),
}).strict();

const RoutingSchema = z.object({
    scope: z.enum(['all', 'monitors']).default('all'),
    /** Monitor keys from this file (or monitor UUIDs). */
    monitors: z.array(z.string()).max(500).optional(),
}).strict();

const IntegrationSchema = z.object({
    name: z.string().min(1).max(80),
    type: z.string().min(2).max(40),
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    routing: RoutingSchema.optional(),
}).strict();

const ManifestSchema = z.object({
    version: z.literal(MANIFEST_VERSION).default(MANIFEST_VERSION),
    defaults: z.object({
        type: z.string().optional(),
        interval_seconds: z.number().int().positive().optional(),
        regions: z.union([z.array(z.string()).min(1), z.null()]).optional(),
        tags: z.array(z.string()).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
    }).strict().optional(),
    settings: z.object({
        /** Delete keyed monitors that are not in this file. */
        prune: z.boolean().optional(),
        /** First apply: claim existing unkeyed monitors with the same name and type. */
        adopt_by_name: z.boolean().optional(),
        /** Delete integrations of the declared types that are not in this file. */
        prune_integrations: z.boolean().optional(),
    }).strict().optional(),
    monitors: z.array(MonitorSchema).max(500).default([]),
    status_pages: z.array(StatusPageSchema).max(100).optional(),
    integrations: z.array(IntegrationSchema).max(100).optional(),
}).strict();

export type ManifestMonitor = z.infer<typeof MonitorSchema>;
export type ManifestStatusPage = z.infer<typeof StatusPageSchema>;
export type ManifestIntegration = z.infer<typeof IntegrationSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export class ManifestError extends Error {
    constructor(message: string, public readonly issues: string[] = []) {
        super(issues.length ? `${message}\n${issues.map((issue) => `  - ${issue}`).join('\n')}` : message);
        this.name = 'ManifestError';
    }
}

/**
 * ${VAR} and ${VAR:-default} in any string value. $${VAR} is a literal
 * "${VAR}". A missing variable without a default is an error, so a secret is
 * never silently replaced by an empty string.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, path = '', missing: string[] = []): unknown {
    if (typeof value === 'string') {
        return value.replace(/\$?\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback: string | undefined) => {
            if (match.startsWith('$$')) return match.slice(1);
            const resolved = env[name];
            if (resolved !== undefined && resolved !== '') return resolved;
            if (fallback !== undefined) return fallback;
            missing.push(`${name} (at ${path || 'root'})`);
            return '';
        });
    }
    if (Array.isArray(value)) return value.map((item, index) => interpolateEnv(item, env, `${path}[${index}]`, missing));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env, path ? `${path}.${key}` : key, missing)]));
    }
    return value;
}

function issuesOf(error: z.ZodError): string[] {
    return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

export function parseManifest(source: string, env: NodeJS.ProcessEnv = process.env): Manifest {
    let raw: unknown;
    try {
        raw = parseYaml(source);
    } catch (error) {
        throw new ManifestError(`sutramx.yml is not valid YAML: ${(error as Error).message}`);
    }
    if (raw === null || raw === undefined) raw = {};
    const missing: string[] = [];
    const expanded = interpolateEnv(raw, env, '', missing);
    if (missing.length) throw new ManifestError('Environment variables referenced in sutramx.yml are not set:', missing);
    const parsed = ManifestSchema.safeParse(expanded);
    if (!parsed.success) throw new ManifestError('sutramx.yml is invalid:', issuesOf(parsed.error));

    const manifest = parsed.data;
    const problems: string[] = [];
    const duplicates = (values: string[], label: string) => {
        const seen = new Set<string>();
        for (const value of values) {
            if (seen.has(value)) problems.push(`duplicate ${label}: ${value}`);
            seen.add(value);
        }
    };
    duplicates(manifest.monitors.map((monitor) => monitor.key), 'monitor key');
    duplicates((manifest.status_pages || []).map((page) => page.slug), 'status page slug');
    duplicates((manifest.integrations || []).map((integration) => `${integration.type}/${integration.name}`), 'integration');
    if (problems.length) throw new ManifestError('sutramx.yml is invalid:', problems);
    return manifest;
}

export function loadManifest(path: string, env: NodeJS.ProcessEnv = process.env): Manifest {
    let source: string;
    try {
        source = readFileSync(path, 'utf8');
    } catch (error) {
        throw new ManifestError(`Cannot read ${path}: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found (create one with `sutramx init`)' : (error as Error).message}`);
    }
    return parseManifest(source, env);
}

/** Monitor specs as sent to POST /automation/monitors/plan, with defaults merged in. */
export function monitorSpecs(manifest: Manifest): Array<Record<string, unknown>> {
    const defaults = manifest.defaults || {};
    return manifest.monitors.map((monitor) => {
        const spec: Record<string, unknown> = { ...monitor };
        if (spec.type === undefined && defaults.type !== undefined) spec.type = defaults.type;
        if (spec.interval_seconds === undefined && defaults.interval_seconds !== undefined) spec.interval_seconds = defaults.interval_seconds;
        if (spec.regions === undefined && defaults.regions !== undefined) spec.regions = defaults.regions;
        if (defaults.tags?.length) spec.tags = [...new Set([...(defaults.tags || []), ...((monitor.tags as string[] | undefined) || [])])];
        if (defaults.config) spec.config = { ...defaults.config, ...(monitor.config || {}) };
        return spec;
    });
}
