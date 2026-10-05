import { stringify } from 'yaml';
import { MANIFEST_VERSION } from './manifest.js';

/** Builds a sutramx.yml from the workspace's current monitors (`sutramx init --from-workspace`). */

export interface ExportableMonitor {
    id: string;
    external_id?: string | null;
    name: string;
    type: string;
    url?: string | null;
    interval_seconds: number;
    is_active: boolean;
    config?: Record<string, unknown>;
    tags?: string[];
    probe_regions?: string[] | null;
}

export function slugKey(name: string): string {
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    return slug || 'monitor';
}

/** What the API shows instead of a stored credential (header values, tokens, URL passwords). */
export const MASKED_SECRET = '[REDACTED]';

function hasMaskedSecret(value: unknown): boolean {
    if (typeof value === 'string') return value.includes(MASKED_SECRET) || value.toUpperCase().includes('%5BREDACTED%5D');
    if (Array.isArray(value)) return value.some(hasMaskedSecret);
    if (value && typeof value === 'object') return Object.values(value).some(hasMaskedSecret);
    return false;
}

// Keys written by dedicated endpoints or derived by the server: not part of the declared config.
const NON_DECLARATIVE_CONFIG_KEYS = new Set(['notification_emails']);

/**
 * Types managed through their own API (browser checks): plan/apply never see
 * them, so a file declaring one fails to plan. Same list as the API's
 * SELF_SCHEDULED_MONITOR_TYPES.
 */
export const NOT_DECLARABLE_TYPES = new Set(['browser']);

export function exportMonitors(all: ExportableMonitor[]): { yaml: string; exported: number; adopted: number; duplicateNames: string[]; skipped: ExportableMonitor[]; } {
    const skipped = all.filter((monitor) => NOT_DECLARABLE_TYPES.has(monitor.type));
    const monitors = all.filter((monitor) => !NOT_DECLARABLE_TYPES.has(monitor.type));
    const used = new Set(monitors.map((monitor) => monitor.external_id).filter(Boolean) as string[]);
    const nameCount = new Map<string, number>();
    for (const monitor of monitors) nameCount.set(`${monitor.type}/${monitor.name}`, (nameCount.get(`${monitor.type}/${monitor.name}`) || 0) + 1);
    let adopted = 0;
    const entries = [...monitors].reverse().map((monitor) => {
        let key = monitor.external_id || '';
        if (!key) {
            adopted += 1;
            const base = slugKey(monitor.name);
            key = base;
            for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
            used.add(key);
        }
        const config = Object.fromEntries(Object.entries(monitor.config || {}).filter(([name]) => !NON_DECLARATIVE_CONFIG_KEYS.has(name)));
        const entry: Record<string, unknown> = { key, name: monitor.name, type: monitor.type };
        if (monitor.url) entry.url = monitor.url;
        entry.interval_seconds = monitor.interval_seconds;
        if (Object.keys(config).length) entry.config = config;
        if (monitor.tags?.length) entry.tags = monitor.tags;
        if (monitor.probe_regions?.length) entry.regions = monitor.probe_regions;
        if (!monitor.is_active) entry.paused = true;
        return entry;
    });
    const document = {
        version: MANIFEST_VERSION,
        settings: { prune: false, adopt_by_name: adopted > 0 },
        monitors: entries,
    };
    const header = [
        '# sutramx.yml: monitors as code. Preview with `sutramx plan`, apply with `sutramx apply`.',
        '# Generated from the workspace by `sutramx init --from-workspace`.',
        adopted > 0 ? '# adopt_by_name links existing monitors to these keys on the first apply; you can remove it afterwards.' : '',
        // Stored credentials are write-only: the API returns them masked.
        hasMaskedSecret(entries) ? `# ${MASKED_SECRET} marks a stored credential the API does not reveal. apply keeps the stored value as long as the URL's origin is unchanged; replace it (e.g. with \${ENV_VAR}) to manage it here.` : '',
    ].filter(Boolean).join('\n');
    const duplicateNames = [...nameCount.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    return { yaml: `${header}\n${stringify(document, { lineWidth: 0 })}`, exported: monitors.length, adopted, duplicateNames, skipped };
}

export const SAMPLE_MANIFEST = `# sutramx.yml: monitors as code.
# Preview changes with \`sutramx plan\` (or \`sutramx diff\`), apply them with \`sutramx apply\`.
# Values like \${SLACK_WEBHOOK_URL} are read from the environment.
version: ${MANIFEST_VERSION}

defaults:
  interval_seconds: 60
  tags: [prod]

settings:
  # Delete monitors that have a key but are no longer in this file.
  prune: false

monitors:
  - key: homepage
    name: Homepage
    url: https://example.com

  - key: api-health
    name: API health
    type: api
    url: https://api.example.com/health
    config:
      expected_status_codes: [200]
      timeout: 10000

  - key: nightly-backup
    name: Nightly backup
    type: cron
    config:
      cron_expression: "0 2 * * *"

# status_pages:
#   - slug: example-status
#     title: Example status
#     is_public: true
#     monitors:
#       - homepage
#       - key: api-health
#         section: API

# Managing integrations needs an API key with the "Automation" access level.
# integrations:
#   - name: Ops Slack
#     type: slack
#     config:
#       webhook_url: \${SLACK_WEBHOOK_URL}
#     routing:
#       scope: monitors
#       monitors: [homepage, api-health]
`;
