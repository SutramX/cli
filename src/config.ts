import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_API_URL, SutramXApi } from './api.js';

/**
 * Credentials: SUTRAMX_API_KEY / SUTRAMX_API_URL win (CI), otherwise the
 * file written by `sutramx login` ($SUTRAMX_CONFIG, else
 * $XDG_CONFIG_HOME/sutramx/credentials.json, else ~/.config/sutramx/credentials.json),
 * created with mode 0600.
 */

export interface StoredCredentials {
    api_key: string;
    api_url?: string;
    workspace_id?: string;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.SUTRAMX_CONFIG) return env.SUTRAMX_CONFIG;
    const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(base, 'sutramx', 'credentials.json');
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): StoredCredentials | null {
    const path = credentialsPath(env);
    if (!existsSync(path)) return null;
    try {
        if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
            process.stderr.write(`Warning: ${path} is readable by other users; run \`chmod 600 ${path}\`.\n`);
        }
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || typeof parsed.api_key !== 'string') return null;
        // Only the known fields: nothing else from the file is trusted.
        return {
            api_key: parsed.api_key,
            ...(typeof parsed.api_url === 'string' ? { api_url: parsed.api_url } : {}),
            ...(typeof parsed.workspace_id === 'string' ? { workspace_id: parsed.workspace_id } : {}),
        };
    } catch {
        return null;
    }
}

export function writeCredentials(credentials: StoredCredentials, env: NodeJS.ProcessEnv = process.env): string {
    const path = credentialsPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Written to a fresh temp file (O_EXCL: never follows a planted symlink)
    // and renamed over the target, so the key is never in a file that is or
    // was readable by others.
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
        writeSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
    } finally {
        closeSync(fd);
    }
    chmodSync(temp, 0o600);
    try {
        if (lstatSync(path).isSymbolicLink()) rmSync(path);
    } catch {
        // does not exist yet
    }
    renameSync(temp, path);
    return path;
}

export function removeCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
    const path = credentialsPath(env);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
}

export interface ResolvedAuth {
    apiKey: string;
    apiUrl: string;
    source: 'env' | 'file';
}

export function resolveAuth(overrides: { apiUrl?: string; } = {}, env: NodeJS.ProcessEnv = process.env): ResolvedAuth | null {
    const stored = readCredentials(env);
    const apiUrl = overrides.apiUrl || env.SUTRAMX_API_URL || stored?.api_url || DEFAULT_API_URL;
    if (env.SUTRAMX_API_KEY) return { apiKey: env.SUTRAMX_API_KEY.trim(), apiUrl, source: 'env' };
    if (stored) return { apiKey: stored.api_key, apiUrl, source: 'file' };
    return null;
}

export class NotLoggedInError extends Error {
    constructor() {
        super('Not logged in. Run `sutramx login` or set SUTRAMX_API_KEY.');
        this.name = 'NotLoggedInError';
    }
}

export function apiFromEnvironment(overrides: { apiUrl?: string; } = {}): SutramXApi {
    const auth = resolveAuth(overrides);
    if (!auth) throw new NotLoggedInError();
    return new SutramXApi(auth.apiKey, auth.apiUrl);
}
