#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import { ApiError, describeError, SutramXApi } from './api.js';
import { apiFromEnvironment, credentialsPath, NotLoggedInError, removeCredentials, resolveAuth, writeCredentials } from './config.js';
import { exportMonitors, SAMPLE_MANIFEST } from './exportManifest.js';
import { readSecret as readSecretFrom } from './prompt.js';
import { loadManifest, Manifest, ManifestError } from './manifest.js';
import {
    acknowledgeIncident, addIncidentNote, CHECK_STATUSES, getIncident, getStatusPage, INCIDENT_STATUSES, listChecks, listIncidents, listMaintenance,
    listStatusPages, MAINTENANCE_STATUSES, MONITOR_STATUSES, renderChecks, renderIncident, renderIncidentTable, renderMaintenanceTable, renderMonitor,
    renderRunCheck, renderStatusPage, renderStatusPages, renderUptimeReport, REPORT_DAYS, requireRegionCode, resolveIncident, runCheck, updateMonitor, uptimeReport,
} from './operations.js';
import { bold, clean, cyan, dim, green, red, renderPlan, renderStep, table, yellow } from './render.js';
import { VERSION } from './version.js';
import { applyPlan, buildPlan, checkTarget, destructiveCounts, effectiveOptions, PlanChangedError, PlanOptions, pruneSettingWarnings, redactedPlan } from './workspace.js';

/** Exit codes: 0 ok / no changes, 1 error, 2 changes present (plan --detailed-exitcode). */

interface GlobalOptions {
    apiUrl?: string;
}

const program = new Command();
program
    .name('sutramx')
    .description('SutramX uptime monitoring from the command line, and monitors as code with sutramx.yml.')
    .version(VERSION)
    .addOption(new Option('--api-url <url>', 'API base URL').env('SUTRAMX_API_URL'))
    .showHelpAfterError();

function api(): SutramXApi {
    return apiFromEnvironment({ apiUrl: (program.opts() as GlobalOptions).apiUrl });
}

function printJson(value: unknown) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readSecret(prompt: string): Promise<string> {
    return readSecretFrom(prompt, stdin, stdout);
}

async function confirm(question: string): Promise<boolean> {
    if (!stdin.isTTY) return false;
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        const answer = await rl.question(`${question} Type "yes" to continue: `);
        return answer.trim().toLowerCase() === 'yes';
    } finally {
        rl.close();
    }
}

program.command('login')
    .description('Save an API key (create one in SutramX → Settings → API keys)')
    .option('--api-key <key>', 'API key (avoid: visible in shell history and `ps`; prefer the prompt or stdin)')
    .action(async (options: { apiKey?: string; }) => {
        const apiUrl = (program.opts() as GlobalOptions).apiUrl;
        // Only an explicit --api-url is saved; SUTRAMX_API_URL from the
        // environment applies to this run but is not made permanent.
        const persistApiUrl = program.getOptionValueSource('apiUrl') === 'cli' ? apiUrl : undefined;
        if (options.apiKey) process.stderr.write(yellow('Warning: --api-key is visible to other local users (ps) and in shell history. Prefer `echo "$KEY" | sutramx login` or the prompt.\n'));
        const key = (options.apiKey || await readSecret('SutramX API key (sk_...): ')).trim();
        if (!key.startsWith('sk_')) throw new Error('SutramX API keys start with "sk_".');
        const client = new SutramXApi(key, apiUrl || resolveAuth({ apiUrl })?.apiUrl);
        const me = await client.get<Record<string, any>>('/automation/whoami');
        const path = writeCredentials({ api_key: key, ...(persistApiUrl ? { api_url: client.baseUrl } : {}), workspace_id: me.workspace_id });
        stdout.write(`${green('Logged in')} to workspace ${bold(clean(me.workspace_id))} (${clean(me.plan)} plan, ${clean(me.api_key_access)} access). Saved to ${path}\n`);
    });

program.command('logout')
    .description('Remove the saved API key')
    .action(() => {
        stdout.write(removeCredentials() ? `Removed ${credentialsPath()}\n` : 'Not logged in.\n');
    });

program.command('whoami')
    .description('Show the workspace, plan and limits for the current key')
    .option('--json', 'JSON output')
    .action(async (options: { json?: boolean; }) => {
        const me = await api().get<Record<string, any>>('/automation/whoami');
        if (options.json) return printJson(me);
        const limits = me.limits || {};
        stdout.write([
            `workspace   ${me.workspace_id}`,
            `plan        ${me.plan} (${me.market})`,
            `credential  ${me.auth_type}${me.api_key_access ? `, ${me.api_key_access} access` : ''}`,
            `limits      ${limits.monitors ?? 'unlimited'} monitors, ${limits.min_interval_seconds}s minimum interval, ${limits.probe_locations ?? 'all'} locations per monitor, ${limits.status_pages ?? 'unlimited'} status pages`,
            `integrations ${me.can_manage_alert_channels ? 'can be managed with this key' : dim('read-only with this key (needs automation access)')}`,
        ].join('\n') + '\n');
    });

const monitors = program.command('monitors').alias('monitor').description('List and manage monitors');

monitors.command('list').alias('ls')
    .description('List monitors with their status')
    .option('--tag <tag>', 'only monitors with this tag')
    .addOption(new Option('--status <status>', 'only monitors in this status').choices(MONITOR_STATUSES))
    .option('--json', 'JSON output')
    .action(async (options: { tag?: string; status?: string; json?: boolean; }) => {
        let list = await api().get<Array<Record<string, any>>>('/monitors', { tag: options.tag });
        if (options.status) list = list.filter((monitor) => monitor.current_status === options.status);
        if (options.json) return printJson(list);
        if (!list.length) return void stdout.write('No monitors.\n');
        const colour = (status: string) => (status === 'up' ? green(status) : status === 'down' ? red(status) : status === 'degraded' ? yellow(status) : dim(status));
        stdout.write(`${table(list.map((monitor) => [
            monitor.id, monitor.external_id || '', monitor.name, monitor.type, String(monitor.current_status || ''),
            monitor.uptime_24h == null ? '' : `${monitor.uptime_24h}%`, String(monitor.interval_seconds), monitor.url || '',
        ]), ['ID', 'KEY', 'NAME', 'TYPE', 'STATUS', '24H', 'EVERY', 'TARGET']).replace(/ (up|down|degraded|paused|pending|maintenance) /g, (match, status) => ` ${colour(status)} `)}\n`);
    });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONITOR_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function requireUuid(value: string, label: string): string {
    if (!UUID.test(value)) throw new InvalidArgumentError(`${label} must be a UUID`);
    return value;
}

/** GET path for a monitor given its id or its sutramx.yml key. */
function monitorPath(idOrKey: string): string {
    if (UUID.test(idOrKey)) return `/monitors/${idOrKey}`;
    if (!MONITOR_KEY.test(idOrKey)) throw new Error('Expected a monitor id (UUID) or key (letters, digits and . _ : / -, up to 128 characters).');
    return `/automation/monitors/${encodeURIComponent(idOrKey)}`;
}

/** Monitor ids returned by the API, before they go into a path. */
function monitorId(monitor: Record<string, any>): string {
    return requireUuid(String(monitor?.id), 'monitor id');
}

monitors.command('get <idOrKey>')
    .description('Show one monitor by id or key')
    .option('--json', 'JSON output (full config)')
    .action(async (idOrKey: string, options: { json?: boolean; }) => {
        const monitor = await api().get<Record<string, any>>(monitorPath(idOrKey));
        if (options.json) return printJson(monitor);
        stdout.write(`${renderMonitor(monitor)}\n`);
    });

/** Monitor id for an id or key argument (one lookup for keys). */
async function resolveMonitorId(client: SutramXApi, idOrKey: string): Promise<string> {
    return UUID.test(idOrKey) ? idOrKey : monitorId(await client.get<Record<string, any>>(monitorPath(idOrKey)));
}

function collect(value: string, previous: string[] = []) {
    return [...previous, value];
}

function parseConfig(value: string | undefined): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error('--config must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--config must be a JSON object');
    return parsed as Record<string, unknown>;
}

/** Monitor types the API accepts (POST /monitors, sutramx.yml). dns and multistep need a plan that includes them. */
const MONITOR_TYPES = ['http', 'api', 'ping', 'port', 'udp', 'dns', 'multistep', 'mcp', 'cron'] as const;

function parseInterval(value: string): number {
    const seconds = Number(value);
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new InvalidArgumentError('must be a whole number of seconds, e.g. 60');
    }
    return seconds;
}

monitors.command('create')
    .description('Create a monitor (with --key: create or update the monitor with that key)')
    .requiredOption('--name <name>', 'display name')
    .option('--url <url>', 'target URL (required for http/api/mcp; mcp needs https://; other types take their target from --config)')
    .option('--type <type>', `monitor type: ${MONITOR_TYPES.join(', ')}`, 'http')
    .option('--interval <seconds>', 'seconds between checks (15-900; the plan sets the minimum)', parseInterval)
    .option('--region <code>', 'probe location (repeatable)', collect)
    .option('--tag <tag>', 'tag (repeatable)', collect)
    .option('--config <json>', 'type-specific config as JSON, e.g. \'{"host":"db.example.com","port":5432}\' (port), \'{"hostname":"example.com","record_type":"MX"}\' (dns), \'{"steps":[...]}\' (multistep), \'{"expected_tools":["search"],"headers":{"Authorization":"Bearer ..."}}\' (mcp)')
    .option('--key <key>', 'stable key for idempotent create-or-update')
    .option('--paused', 'create it paused')
    .option('--json', 'JSON output')
    .action(async (options: Record<string, any>) => {
        const body: Record<string, unknown> = { name: options.name, type: options.type };
        if (options.url) body.url = options.url;
        if (options.interval) body.interval_seconds = options.interval;
        if (options.region?.length) body.regions = options.region;
        if (options.tag?.length) body.tags = options.tag;
        if (!(MONITOR_TYPES as readonly string[]).includes(options.type)) throw new Error(`--type must be one of ${MONITOR_TYPES.join(', ')}`);
        options.region?.forEach((code: string) => requireRegionCode(code));
        if (options.config !== undefined) body.config = parseConfig(options.config);
        const client = api();
        let monitor: Record<string, any>;
        let action = 'created';
        if (options.key) {
            if (!MONITOR_KEY.test(options.key)) throw new Error('--key: letters, digits and . _ : / - (1-128 characters, starting with a letter or digit)');
            const result = await client.put<{ action: string; monitor: Record<string, any>; }>(`/automation/monitors/${encodeURIComponent(options.key)}`, { ...body, ...(options.paused ? { paused: true } : {}) });
            monitor = result.monitor;
            action = result.action;
        } else {
            monitor = await client.post('/monitors', body);
            if (options.paused) monitor = await client.post(`/monitors/${monitorId(monitor)}/pause`);
        }
        if (options.json) return printJson({ action, monitor });
        stdout.write(`${green(action)} ${bold(clean(monitor.name))} (${clean(monitor.id)})\n`);
    });

monitors.command('delete <idOrKey>').alias('rm')
    .description('Delete a monitor (by id or key) and its history')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (idOrKey: string, options: { yes?: boolean; }) => {
        const client = api();
        const monitor = await client.get<Record<string, any>>(monitorPath(idOrKey));
        if (!options.yes && !(await confirm(`Delete ${bold(clean(monitor.name))} and its check history?`))) {
            throw new Error('Not deleted (pass --yes to skip the prompt in scripts).');
        }
        await client.delete(`/monitors/${monitorId(monitor)}`);
        stdout.write(`${red('deleted')} ${clean(monitor.name)} (${clean(monitor.id)})\n`);
    });

for (const verb of ['pause', 'resume'] as const) {
    monitors.command(`${verb} <idOrKey>`)
        .description(verb === 'pause' ? 'Stop checking a monitor (by id or key)' : 'Resume a paused monitor (by id or key)')
        .action(async (idOrKey: string) => {
            const client = api();
            const id = UUID.test(idOrKey) ? idOrKey : monitorId(await client.get<Record<string, any>>(monitorPath(idOrKey)));
            const monitor = await client.post<Record<string, any>>(`/monitors/${id}/${verb}`);
            stdout.write(`${verb === 'pause' ? 'paused' : 'resumed'} ${bold(clean(monitor.name))} (${id})\n`);
        });
}

monitors.command('update <idOrKey>')
    .description('Change a monitor (by id or key); only the options you pass change')
    .option('--name <name>', 'display name')
    .option('--url <url>', 'target URL')
    .option('--interval <seconds>', 'seconds between checks', parseInterval)
    .option('--tag <tag>', 'tag (repeatable; replaces all tags)', collect)
    .option('--region <code>', 'probe location (repeatable; replaces all locations)', collect)
    .option('--config <json>', 'type-specific config as JSON; replaces the whole config, so start from `monitors get --json`')
    .option('--json', 'JSON output')
    .action(async (idOrKey: string, options: { name?: string; url?: string; interval?: number; tag?: string[]; region?: string[]; config?: string; json?: boolean; }) => {
        const client = api();
        const id = await resolveMonitorId(client, idOrKey);
        const monitor = await updateMonitor(client, id, {
            name: options.name, url: options.url, interval_seconds: options.interval, tags: options.tag, config: parseConfig(options.config), regions: options.region,
        });
        if (options.json) return printJson(monitor);
        stdout.write(`${yellow('updated')} ${bold(clean(monitor.name))} (${clean(monitor.id)})\n`);
    });

monitors.command('checks <idOrKey>')
    .description('Check history of a monitor (by id or key), newest first')
    .option('--limit <n>', 'rows (1-500)', parsePositive(500), 50)
    .option('--before <time>', 'only checks before this time (ISO-8601; the "Older" cursor of the previous page)')
    .option('--region <code>', 'only this probe location')
    .addOption(new Option('--status <status>', 'only checks with this status (problem: every non-up check)').choices(CHECK_STATUSES))
    .option('--json', 'JSON output')
    .action(async (idOrKey: string, options: { limit: number; before?: string; region?: string; status?: string; json?: boolean; }) => {
        const client = api();
        const page = await listChecks(client, await resolveMonitorId(client, idOrKey), options);
        if (options.json) return printJson(page);
        stdout.write(`${renderChecks(page)}\n`);
    });

monitors.command('run-check <idOrKey>')
    .description('Run one real check of a monitor (by id or key) now and record it')
    .option('--json', 'JSON output')
    .action(async (idOrKey: string, options: { json?: boolean; }) => {
        const client = api();
        const result = await runCheck(client, await resolveMonitorId(client, idOrKey));
        if (options.json) return printJson(result);
        stdout.write(`${renderRunCheck(result)}\n`);
    });

monitors.command('adopt <id> <key>')
    .description('Give an existing monitor a key so sutramx.yml manages it')
    .action(async (id: string, key: string) => {
        requireUuid(id, 'id');
        if (!MONITOR_KEY.test(key)) throw new Error('key: letters, digits and . _ : / - (1-128 characters, starting with a letter or digit)');
        const monitor = await api().put<Record<string, any>>(`/automation/monitors/by-id/${id}/key`, { key });
        stdout.write(`${bold(clean(monitor.name))} is now managed as ${cyan(key)}\n`);
    });

function parsePositive(max: number) {
    return (value: string): number => {
        const number = Number(value);
        if (!/^\d+$/.test(value.trim()) || number < 1 || number > max) throw new InvalidArgumentError(`must be a whole number from 1 to ${max}`);
        return number;
    };
}

const incidents = program.command('incidents').alias('incident').description('List, acknowledge and resolve incidents (confirmed outages)');

incidents.command('list').alias('ls')
    .description('List incidents, newest first')
    .addOption(new Option('--status <status>', 'incident state').choices(INCIDENT_STATUSES).default('all'))
    .option('--monitor <idOrKey>', 'only incidents of this monitor (id or key)')
    .option('--search <text>', 'search monitor name or URL')
    .option('--from <time>', 'started at or after (ISO-8601)')
    .option('--to <time>', 'started at or before (ISO-8601)')
    .option('--page <n>', 'page number', parsePositive(10_000), 1)
    .option('--page-size <n>', 'incidents per page (1-100)', parsePositive(100), 25)
    .option('--json', 'JSON output')
    .action(async (options: { status: string; monitor?: string; search?: string; from?: string; to?: string; page: number; pageSize: number; json?: boolean; }) => {
        const client = api();
        let monitorFilter: string | undefined;
        if (options.monitor) {
            monitorFilter = UUID.test(options.monitor) ? options.monitor : monitorId(await client.get<Record<string, any>>(monitorPath(options.monitor)));
        }
        const list = await listIncidents(client, { ...options, monitorId: monitorFilter });
        if (options.json) return printJson(list);
        stdout.write(`${renderIncidentTable(list)}\n`);
    });

incidents.command('get <id>')
    .description('Show one incident')
    .option('--json', 'JSON output (with the timeline)')
    .action(async (id: string, options: { json?: boolean; }) => {
        const { incident, raw } = await getIncident(api(), id);
        if (options.json) return printJson(raw);
        stdout.write(`${renderIncident(incident)}\n`);
    });

incidents.command('ack <id>').alias('acknowledge')
    .description('Acknowledge an ongoing incident (stops escalation)')
    .option('--json', 'JSON output')
    .action(async (id: string, options: { json?: boolean; }) => {
        const incident = await acknowledgeIncident(api(), id);
        if (options.json) return printJson({ incident });
        stdout.write(`${yellow('acknowledged')} incident ${clean(incident.id)} on ${bold(clean(incident.monitor_name))}\n`);
    });

incidents.command('resolve <id>')
    .description('Resolve an ongoing incident by hand (incidents also resolve when checks recover)')
    .option('--note <text>', 'what was done, shown on the incident timeline')
    .option('--json', 'JSON output')
    .action(async (id: string, options: { note?: string; json?: boolean; }) => {
        const incident = await resolveIncident(api(), id, options.note);
        if (options.json) return printJson({ incident });
        stdout.write(`${green('resolved')} incident ${clean(incident.id)} on ${bold(clean(incident.monitor_name))}\n`);
    });

incidents.command('note <id> <text>')
    .description('Add a note to an incident timeline (internal unless --public)')
    .option('--public', 'publish it as a public update on your status pages (asks for confirmation)')
    .option('-y, --yes', 'do not ask for confirmation (with --public)')
    .option('--json', 'JSON output')
    .action(async (id: string, text: string, options: { public?: boolean; yes?: boolean; json?: boolean; }) => {
        if (options.public && !options.yes && !(await confirm(`Publish this update on your public status pages?\n  ${clean(text).slice(0, 500)}\n`))) {
            throw new Error('Not published (pass --yes to skip the prompt in scripts).');
        }
        const note = await addIncidentNote(api(), id, text, options.public === true);
        if (options.json) return printJson({ note });
        stdout.write(`${green('added')} ${options.public ? 'public update' : 'internal note'} to incident ${clean(id)}\n`);
    });

const statusPages = program.command('status-pages').alias('status-page').description('Status pages (read-only here; manage them with sutramx.yml or the dashboard)');

statusPages.command('list').alias('ls')
    .description('List status pages')
    .option('--json', 'JSON output')
    .action(async (options: { json?: boolean; }) => {
        const pages = await listStatusPages(api());
        if (options.json) return printJson(pages);
        stdout.write(`${renderStatusPages(pages)}\n`);
    });

statusPages.command('get <idOrSlug>')
    .description('Show one status page (by id or slug) with its monitors')
    .option('--json', 'JSON output')
    .action(async (idOrSlug: string, options: { json?: boolean; }) => {
        const page = await getStatusPage(api(), idOrSlug);
        if (options.json) return printJson(page);
        stdout.write(`${renderStatusPage(page)}\n`);
    });

program.command('uptime').alias('report')
    .description('Uptime report: uptime %, incidents, MTTR and health per monitor, plus SLO error budgets')
    .addOption(new Option('--days <n>', 'report window').choices(REPORT_DAYS.map(String)).default('30'))
    .option('--monitor <idOrKey>', 'only this monitor')
    .option('--json', 'JSON output')
    .action(async (options: { days: string; monitor?: string; json?: boolean; }) => {
        const client = api();
        const report = await uptimeReport(client, Number(options.days), options.monitor ? await resolveMonitorId(client, options.monitor) : undefined);
        if (options.json) return printJson(report);
        stdout.write(`${renderUptimeReport(report)}\n`);
    });

const maintenance = program.command('maintenance').description('Maintenance windows (alerts are silenced while one is active)');

maintenance.command('list').alias('ls')
    .description('List maintenance windows (creating and deleting them is owner-only, in the dashboard)')
    .addOption(new Option('--status <status>', 'only windows in this state').choices(MAINTENANCE_STATUSES))
    .option('--json', 'JSON output')
    .action(async (options: { status?: string; json?: boolean; }) => {
        const list = await listMaintenance(api(), options.status);
        if (options.json) return printJson(list);
        stdout.write(`${renderMaintenanceTable(list)}\n`);
    });

program.command('regions')
    .description('List probe locations')
    .option('--json', 'JSON output')
    .action(async (options: { json?: boolean; }) => {
        const client = resolveAuth() ? api() : new SutramXApi('', (program.opts() as GlobalOptions).apiUrl);
        const data = await client.getPublic<{ regions: Array<Record<string, any>>; }>('/catalog/regions');
        if (options.json) return printJson(data.regions);
        stdout.write(`${table(data.regions.map((region) => [region.code, region.name, region.country || '', region.online === false ? 'offline' : 'online']), ['CODE', 'NAME', 'COUNTRY', 'STATE'])}\n`);
    });

program.command('init')
    .description('Create a sutramx.yml')
    .option('-f, --file <path>', 'file to write', 'sutramx.yml')
    .option('--from-workspace', 'describe the monitors that exist now')
    .option('--force', 'overwrite an existing file')
    .action(async (options: { file: string; fromWorkspace?: boolean; force?: boolean; }) => {
        if (existsSync(options.file) && !options.force) throw new Error(`${options.file} already exists (use --force to overwrite).`);
        // 'wx' also refuses a dangling symlink planted at the path.
        const flag = options.force ? 'w' : 'wx';
        if (!options.fromWorkspace) {
            writeFileSync(options.file, SAMPLE_MANIFEST, { flag });
            stdout.write(`Wrote ${options.file}. Edit it, then run ${bold('sutramx plan')}.\n`);
            return;
        }
        const list = await api().get<any[]>('/monitors');
        const { yaml, exported, adopted, duplicateNames, skipped } = exportMonitors(list);
        writeFileSync(options.file, yaml, { flag });
        stdout.write(`Wrote ${options.file} with ${exported} monitors${adopted ? ` (${adopted} will be linked by name on the first apply)` : ''}.\n`);
        if (skipped.length) {
            stdout.write(yellow(`Skipped ${skipped.length} ${[...new Set(skipped.map((monitor) => clean(monitor.type)))].join('/')} monitor${skipped.length === 1 ? '' : 's'} (${skipped.map((monitor) => `"${clean(monitor.name)}"`).join(', ')}): ${skipped.length === 1 ? 'it is' : 'they are'} managed in the dashboard, not in sutramx.yml, and apply never changes ${skipped.length === 1 ? 'it' : 'them'}.\n`));
        }
        if (duplicateNames.length) {
            stdout.write(yellow(`Several monitors share these names, so they cannot be linked by name: ${duplicateNames.join(', ')}. Use \`sutramx monitors adopt <id> <key>\` for them before applying.\n`));
        }
        stdout.write(`Run ${bold('sutramx plan')}: it should show no changes except the links.\n`);
    });

function planFlags(command: Command) {
    return command
        .option('-f, --file <path>', 'configuration file', 'sutramx.yml')
        .option('--prune', 'delete keyed monitors that are not in the file (required for any delete; settings.prune alone does nothing)')
        .option('--no-prune', 'never delete monitors')
        .option('--adopt-by-name', 'link existing unkeyed monitors with the same name and type')
        .option('--prune-integrations', 'delete integrations of the declared types that are not in the file')
        .option('--workspace <id>', 'the workspace you mean to change: refuse unless the API key acts on it (confirms a key that differs from the login or settings.workspace_id)')
        .option('--json', 'JSON output');
}

interface PlanCommandOptions {
    file: string;
    prune?: boolean;
    adoptByName?: boolean;
    pruneIntegrations?: boolean;
    workspace?: string;
    json?: boolean;
}

/** Plan, plus the checks that the key acts on the workspace the user expects. */
async function planWithTargetChecks(client: SutramXApi, manifest: Manifest, flags: PlanOptions, options: PlanCommandOptions) {
    const plan = await buildPlan(client, manifest, effectiveOptions(manifest, flags));
    plan.warnings.push(...pruneSettingWarnings(manifest, flags));
    const auth = resolveAuth({ apiUrl: (program.opts() as GlobalOptions).apiUrl });
    const target = checkTarget(plan, {
        confirmedWorkspace: options.workspace,
        declaredWorkspace: manifest.settings?.workspace_id,
        savedWorkspace: auth?.savedWorkspaceId,
        keySource: auth?.source,
    });
    plan.warnings.push(...target.warnings);
    plan.blockers.push(...target.blockers);
    return plan;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** commander sets prune=true for --prune, false for --no-prune and true by default with both declared; read argv instead. */
function pruneFlag(): boolean | undefined {
    if (process.argv.includes('--no-prune')) return false;
    if (process.argv.includes('--prune')) return true;
    return undefined;
}

function flagsFrom(options: PlanCommandOptions): PlanOptions {
    return {
        prune: pruneFlag(),
        adoptByName: options.adoptByName ? true : undefined,
        pruneIntegrations: options.pruneIntegrations ? true : undefined,
    };
}

for (const name of ['plan', 'diff'] as const) {
    planFlags(program.command(name))
        .description(name === 'plan'
            ? 'Show what apply would change (exit 0: none, 2 with --detailed-exitcode: changes)'
            : 'Like plan, with every changed field shown old -> new')
        .option('--detailed-exitcode', 'exit 2 when there are changes')
        .action(async (options: PlanCommandOptions & { detailedExitcode?: boolean; }) => {
            const manifest = loadManifest(options.file);
            const plan = await planWithTargetChecks(api(), manifest, flagsFrom(options), options);
            if (options.json) printJson(redactedPlan(plan));
            else stdout.write(`${renderPlan(plan, { detailed: name === 'diff' })}\n`);
            if (options.detailedExitcode && plan.hasChanges) process.exitCode = 2;
        });
}

planFlags(program.command('apply'))
    .description('Make SutramX match the configuration')
    .option('--auto-approve', 'apply without asking (CI)')
    .option('-y, --yes', 'same as --auto-approve')
    .option('--continue-on-error', 'keep going after a failed change')
    .option('--allow-replace', 'allow monitors whose type changed to be deleted (with their history) and created again (also allowed by --prune)')
    .option('--allow-delete-all', 'allow a prune that deletes every managed monitor (the file declares none)')
    .option('--force-prune-without-plan-check', 'with --prune against an API that cannot verify the plan (no plan fingerprint): delete anyway')
    .action(async (options: PlanCommandOptions & { yes?: boolean; autoApprove?: boolean; continueOnError?: boolean; allowReplace?: boolean; allowDeleteAll?: boolean; forcePruneWithoutPlanCheck?: boolean; }) => {
        const manifest = loadManifest(options.file);
        const client = api();
        const flags = flagsFrom(options);
        const effective = effectiveOptions(manifest, flags);
        const plan = await planWithTargetChecks(client, manifest, flags, options);
        if (!options.json) stdout.write(`${renderPlan(plan)}\n`);
        if (!plan.hasChanges) {
            if (options.json) printJson({ ok: true, changed: false, steps: [] });
            return;
        }
        const { deletes, replaces, integrationDeletes } = destructiveCounts(plan);
        if (deletes > 0 && manifest.monitors.length === 0 && !options.allowDeleteAll) {
            // An empty or truncated file plus prune would wipe the workspace.
            plan.blockers.push(`the file declares no monitors, so prune would delete all ${deletes} managed monitors; pass --allow-delete-all if that is intended`);
        }
        if (replaces > 0 && !effective.prune && !options.allowReplace) {
            // A type change is a delete + create: the old monitor's checks and incidents go.
            plan.blockers.push(`${plural(replaces, 'monitor')} changed type and would be deleted with ${replaces === 1 ? 'its' : 'their'} history and created again; pass --allow-replace (or --prune) if that is intended`);
        }
        // Apply must do what was shown: the plan fingerprint makes the API
        // refuse (409 PLAN_CHANGED) if the workspace changed in between.
        const fingerprint = plan.monitors.plan_fingerprint;
        let prune = effective.prune;
        let allowPruneWithoutFingerprint = false;
        if (!fingerprint) {
            if (prune && deletes === 0) prune = false; // no delete was shown, so none may happen
            const destructive = (prune ? deletes : 0) + replaces;
            if (destructive > 0) {
                if (options.forcePruneWithoutPlanCheck) allowPruneWithoutFingerprint = true;
                else plan.blockers.push(`this API cannot verify that apply deletes only the ${plural(destructive, 'monitor')} shown (no plan fingerprint); run without --prune${replaces ? ' and without type changes' : ''}, or pass --force-prune-without-plan-check`);
            }
        }
        if (plan.blockers.length) {
            throw new Error(`Nothing was applied:\n${plan.blockers.map((blocker) => `  - ${blocker}`).join('\n')}`);
        }
        if (!options.yes && !options.autoApprove) {
            if (!stdin.isTTY) throw new Error('Refusing to apply without confirmation: pass --auto-approve (or --yes) in non-interactive runs.');
            const losses = [
                deletes > 0 ? `${plural(deletes, 'monitor')} will be deleted with ${deletes === 1 ? 'its' : 'their'} history.` : '',
                replaces > 0 ? `${plural(replaces, 'monitor')} will be deleted with ${replaces === 1 ? 'its' : 'their'} history and created again (type change).` : '',
                integrationDeletes > 0 ? `${plural(integrationDeletes, 'integration')} will be deleted.` : '',
            ].filter(Boolean).join(' ');
            const where = plan.target.workspace_id ? ` to workspace ${bold(clean(plan.target.workspace_id))}` : '';
            if (!(await confirm(`\nApply these changes${where}?${losses ? ` ${red(losses)}` : ''}`))) throw new Error('Apply cancelled.');
        }
        const applyOptions = { ...effective, prune, reviewed: plan, continueOnError: options.continueOnError, expectedFingerprint: fingerprint, allowPruneWithoutFingerprint };
        const outcome = await applyPlan(client, manifest, applyOptions, (step) => {
            if (!options.json) stdout.write(`${renderStep(step)}\n`);
        });
        if (options.json) printJson({ ok: outcome.ok, changed: true, steps: outcome.steps });
        else stdout.write(outcome.ok ? `\n${green('Apply complete.')}\n` : `\n${red('Apply finished with errors.')} Fix them and run apply again; completed changes are kept.\n`);
        if (!outcome.ok) process.exitCode = 1;
    });

program.command('validate')
    .description('Check sutramx.yml locally (structure, env variables, duplicates)')
    .option('-f, --file <path>', 'configuration file', 'sutramx.yml')
    .action((options: { file: string; }) => {
        const manifest = loadManifest(options.file);
        stdout.write(`${green('Valid:')} ${manifest.monitors.length} monitors, ${manifest.status_pages?.length || 0} status pages, ${manifest.integrations?.length || 0} integrations. Field rules are checked by \`sutramx plan\`.\n`);
    });

program.parseAsync(process.argv).catch((error: unknown) => {
    if (error instanceof ManifestError || error instanceof NotLoggedInError || error instanceof PlanChangedError) process.stderr.write(`${red('Error:')} ${error.message}\n`);
    else if (error instanceof ApiError) process.stderr.write(`${red('Error:')} ${describeError(error)}\n`);
    else process.stderr.write(`${red('Error:')} ${(error as Error)?.message || String(error)}\n`);
    process.exitCode = 1;
});
