import type { IntegrationChange, StatusPageChange } from './reconcile.js';
import type { MonitorChange, StepResult, WorkspacePlan } from './workspace.js';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code: number) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
export const green = paint(32);
export const red = paint(31);
export const yellow = paint(33);
export const cyan = paint(36);
export const bold = paint(1);
export const dim = paint(2);

/**
 * Server data (monitor names, errors) printed to a terminal: drop control
 * characters so a stored ANSI/OSC escape cannot rewrite the screen, the
 * window title or the clipboard.
 */
export function clean(text: unknown): string {
    // eslint-disable-next-line no-control-regex
    return String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

const SYMBOL: Record<string, string> = {
    create: green('+'),
    update: yellow('~'),
    replace: red('-/+'),
    delete: red('-'),
    noop: dim('='),
};

function value(input: unknown): string {
    if (input === null || input === undefined) return dim('(default)');
    if (typeof input === 'string') return clean(JSON.stringify(input));
    const text = clean(JSON.stringify(input));
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function fieldLines(changes: Array<{ field: string; from: unknown; to: unknown; }>, detailed: boolean): string[] {
    if (!detailed) return changes.length ? [`      ${dim(changes.map((change) => change.field).join(', '))}`] : [];
    return changes.map((change) => `      ${change.field}: ${value(change.from)} ${dim('->')} ${value(change.to)}`);
}

function monitorLines(changes: MonitorChange[], detailed: boolean, showNoop: boolean): string[] {
    const lines: string[] = [];
    for (const change of changes) {
        if (change.action === 'noop' && !showNoop) continue;
        const adopted = change.adopted ? dim(' (adopting existing monitor)') : '';
        lines.push(`  ${SYMBOL[change.action]} ${change.action.padEnd(7)} ${bold(clean(change.key))} ${dim(`"${clean(change.name)}" [${clean(change.type)}]`)}${adopted}`);
        lines.push(...fieldLines(change.changes, detailed));
        if (change.action === 'replace') lines.push(`      ${red('type cannot change in place: the monitor is deleted (with its history) and created again')}`);
    }
    return lines;
}

function pageLines(changes: StatusPageChange[], detailed: boolean, showNoop: boolean): string[] {
    const lines: string[] = [];
    for (const change of changes) {
        if (change.action === 'noop' && !showNoop) continue;
        lines.push(`  ${SYMBOL[change.action]} ${change.action.padEnd(7)} ${bold(clean(change.slug))} ${dim(`"${clean(change.title)}"`)}`);
        lines.push(...fieldLines(change.changes, detailed));
    }
    return lines;
}

function integrationLines(changes: IntegrationChange[], detailed: boolean, showNoop: boolean): string[] {
    const lines: string[] = [];
    for (const change of changes) {
        if (change.action === 'noop' && !showNoop) continue;
        lines.push(`  ${SYMBOL[change.action]} ${change.action.padEnd(7)} ${bold(clean(`${change.type}/${change.name}`))}`);
        lines.push(...fieldLines(change.changes, detailed));
    }
    return lines;
}

export function countActions(plan: WorkspacePlan): Record<'create' | 'update' | 'replace' | 'delete', number> {
    const counts = { create: 0, update: 0, replace: 0, delete: 0 };
    for (const change of [...plan.monitors.changes, ...plan.statusPages, ...plan.integrations]) {
        if (change.action !== 'noop') counts[change.action as keyof typeof counts] += 1;
    }
    return counts;
}

export function renderPlan(plan: WorkspacePlan, options: { detailed?: boolean; showNoop?: boolean; } = {}): string {
    const detailed = options.detailed ?? false;
    const showNoop = options.showNoop ?? false;
    const out: string[] = [];
    if (plan.target?.workspace_id) {
        const details = [plan.target.plan && `${clean(plan.target.plan)} plan`, plan.target.api_key_access && `${clean(plan.target.api_key_access)} key`].filter(Boolean).join(', ');
        out.push(`${bold('Workspace:')} ${clean(plan.target.workspace_id)}${details ? dim(` (${details})`) : ''}`, '');
    }
    const section = (title: string, lines: string[]) => {
        if (lines.length) out.push(bold(title), ...lines, '');
    };
    section('Monitors', monitorLines(plan.monitors.changes, detailed, showNoop));
    section('Status pages', pageLines(plan.statusPages, detailed, showNoop));
    section('Integrations', integrationLines(plan.integrations, detailed, showNoop));
    for (const warning of plan.warnings) out.push(yellow(`Warning: ${clean(warning)}`));
    for (const blocker of plan.blockers || []) out.push(red(`Error: ${clean(blocker)}`));
    if (plan.warnings.length || plan.blockers?.length) out.push('');
    if (!plan.hasChanges) {
        out.push(green('No changes. SutramX matches the configuration.'));
    } else {
        const counts = countActions(plan);
        out.push(`${bold('Plan:')} ${counts.create} to create, ${counts.update} to update, ${counts.replace} to replace, ${counts.delete} to delete.`);
    }
    return out.join('\n');
}

export function renderStep(step: StepResult): string {
    const kind = step.kind.replace('_', ' ');
    step = { ...step, label: clean(step.label), error: step.error === undefined ? undefined : clean(step.error) };
    if (step.status === 'applied') return `${green('✓')} ${step.action} ${kind} ${bold(step.label)}`;
    if (step.status === 'skipped') return `${dim('·')} ${step.action} ${kind} ${step.label} ${dim('(skipped after an earlier failure)')}`;
    return `${red('✗')} ${step.action} ${kind} ${bold(step.label)}: ${step.error}`;
}

export function table(rows: string[][], headers: string[]): string {
    rows = rows.map((row) => row.map(clean));
    const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] || '').length)));
    const line = (cells: string[]) => cells.map((cell, index) => (cell || '').padEnd(widths[index])).join('  ').trimEnd();
    return [bold(line(headers)), ...rows.map(line)].join('\n');
}
