#!/usr/bin/env node
// Version guard: package.json, src/version.ts VERSION and the default
// cli-version of action/action.yml must agree (CI on every push /
// pull_request), so the action never defaults to a moving "latest". With a release tag (argv[2], "v1.2.3") the
// tag must match too. GITHUB_REF_NAME is used only when the workflow runs
// for a version tag (GITHUB_REF_TYPE=tag): on a branch it is "main" or
// "12/merge", not a version.
import { readFileSync } from 'node:fs';

const VERSION_TAG = /^v?\d+\.\d+\.\d+/;

function releaseTag() {
    const explicit = (process.argv[2] || '').trim();
    if (explicit) return explicit;
    const ref = (process.env.GITHUB_REF_NAME || '').trim();
    if (process.env.GITHUB_REF_TYPE === 'tag' && VERSION_TAG.test(ref)) return ref;
    return '';
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const source = /VERSION = '([^']+)'/.exec(readFileSync('src/version.ts', 'utf8'))?.[1];
// The cli-version input's default in the composite action.
const actionDefault = /^\s{2}cli-version:\n(?:\s{4}.*\n)*?\s{4}default:\s*['"]?([^'"\s#]+)/m.exec(
    readFileSync('action/action.yml', 'utf8'),
)?.[1];
const tag = releaseTag().replace(/^v/, '');

const versions = {
    'package.json version': pkg.version,
    'src/version.ts VERSION': source,
    'action/action.yml cli-version default': actionDefault,
    ...(tag ? { tag } : {}),
};
if (new Set(Object.values(versions)).size !== 1) {
    console.error(`::error::versions differ: ${JSON.stringify(versions)}`);
    process.exit(1);
}
console.log(`version ${pkg.version} consistent${tag ? ' with the tag' : ''}`);
