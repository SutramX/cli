# sutramx CLI

Manage SutramX uptime monitors from the terminal, and keep them in code: describe monitors, status pages and alert channels in `sutramx.yml`, review the changes with `sutramx plan`, then `sutramx apply`.

```bash
npm install -g @sutramx/cli      # or: npx @sutramx/cli <command>
sutramx login                    # paste an API key from Settings → API keys
sutramx monitors list
```

Node.js 20 or newer is required.

## Authentication

| Source | Used when |
|---|---|
| `SUTRAMX_API_KEY` (and optionally `SUTRAMX_API_URL`) | set; recommended for CI |
| `sutramx login` | saves the key to `~/.config/sutramx/credentials.json` (mode 0600; `$XDG_CONFIG_HOME` and `$SUTRAMX_CONFIG` are honoured). The API URL is saved only when you pass `--api-url` to `login`; `SUTRAMX_API_URL` in the environment applies to that run only |

A key acts on the one workspace it was created in. Keys have one of three access levels, chosen when the key is created: **Read-only** (`whoami`, `monitors list|get|checks`, `incidents list|get`, `status-pages list|get`, `uptime`, `maintenance list`, `regions`, `init --from-workspace`, `plan` and `diff` work; `apply`, `monitors create|update|pause|resume|delete|adopt|run-check`, `incidents ack|resolve|note` and every other change are refused with `403 READ_ONLY_ACCESS`; use it for CI jobs that only post the plan), **Standard** and **Automation**. A standard key can manage monitors and status pages. To manage **integrations** from `sutramx.yml`, create the key with **Automation access**. Per-monitor alert recipients (`config.notification_emails`) also need an Automation access key; a standard key gets a clear error instead of a change that never applies.

## Commands

| Command | |
|---|---|
| `sutramx login [--api-key sk_...]` | save a key (prompts, or reads it from stdin, when `--api-key` is left out) |
| `sutramx logout` | remove the saved key |
| `sutramx whoami [--json]` | workspace, plan and limits |
| `sutramx monitors list [--tag t] [--status down] [--json]` | monitors with live status (`--status`: up, down, degraded, paused, pending, maintenance); alias `ls` |
| `sutramx monitors get <id or key> [--json]` | one monitor: a readable summary, or the full JSON with `--json` |
| `sutramx monitors create --name N [--url U] [--type api] [--interval 60] [--region fra1 --region usa-az-probe] [--tag prod] [--config '{...}'] [--key k] [--paused] [--json]` | create (with `--key`: create or update) |
| `sutramx monitors update <id or key> [--name N] [--url U] [--interval 60] [--tag t ...] [--region fra1 ...] [--config '{...}'] [--json]` | change only the options given; `--tag`, `--region` and `--config` replace the whole list/object (start from `monitors get --json`) |
| `sutramx monitors pause <id or key>` / `resume <id or key>` | stop or restart checks |
| `sutramx monitors checks <id or key> [--limit 50] [--before <time>] [--region fra1] [--status problem] [--json]` | check history, newest first (`--status`: up, down, degraded, problem) |
| `sutramx monitors run-check <id or key> [--json]` | run one real check now and record it (refused for paused monitors; rate limited) |
| `sutramx monitors delete <id or key> [-y, --yes]` | delete with its history (asks first unless `--yes`); alias `rm` |
| `sutramx monitors adopt <id> <key>` | let `sutramx.yml` manage an existing monitor |
| `sutramx incidents list [--status ongoing] [--monitor <id or key>] [--search t] [--from 2026-10-01] [--to ...] [--page 2] [--page-size 50] [--json]` | incidents, newest first (`--status`: all, ongoing, resolved, acknowledged, suppressed; default all); alias `ls` |
| `sutramx incidents get <id> [--json]` | one incident (`--json` includes the timeline) |
| `sutramx incidents ack <id> [--json]` | acknowledge an ongoing incident (stops escalation); alias `acknowledge` |
| `sutramx incidents resolve <id> [--note "what was done"] [--json]` | resolve by hand; fails with `409 INCIDENT_RESOLVED` if already resolved |
| `sutramx incidents note <id> "text" [--public] [-y, --yes] [--json]` | add an internal timeline note; `--public` publishes it as an update on your status pages and asks first unless `--yes` |
| `sutramx status-pages list [--json]` | status pages with visibility and monitor count; alias `ls` |
| `sutramx status-pages get <id or slug> [--json]` | one status page with its monitors |
| `sutramx uptime [--days 30] [--monitor <id or key>] [--json]` | uptime %, incidents, MTTR and health per monitor, plus SLO error budgets (`--days`: 7, 14, 30, 90); alias `report` |
| `sutramx maintenance list [--status ongoing] [--json]` | maintenance windows with their scope and recurrence (`--status`: scheduled, ongoing, completed, cancelled); alias `ls` |
| `sutramx regions [--json]` | probe location codes (works without a key) |
| `sutramx init [-f file] [--from-workspace] [--force]` | write a starter `sutramx.yml`, or one describing what exists now |
| `sutramx validate [-f file]` | check the file locally |
| `sutramx plan [--detailed-exitcode]` | what `apply` would change |
| `sutramx diff [--detailed-exitcode]` | the plan with every field shown old -> new |
| `sutramx apply [--auto-approve \| -y, --yes] [--continue-on-error] [--allow-replace] [--allow-delete-all] [--force-prune-without-plan-check]` | make SutramX match the file |

`monitors`, `incidents` and `status-pages` also answer to `monitor`, `incident` and `status-page`. Status pages are changed with `sutramx.yml` (or the dashboard), not with single commands. Every command accepts the global `--api-url <url>` (or `SUTRAMX_API_URL`); `sutramx --version` prints the version and `sutramx <command> --help` lists a command's options.

**Monitor types** (`--type`, or `type:` in `sutramx.yml`): `http` (default), `api`, `ping`, `port`, `udp`, `dns`, `multistep`, `mcp` and `cron`. `http`, `api` and `mcp` need a URL (`mcp`: the https:// endpoint of a remote MCP server; the check runs initialize and tools/list, never calls a tool); the others take their target from `config`: `ping` `{"host": ...}`, `port`/`udp` `{"host": ..., "port": ...}`, `dns` `{"hostname": "example.com", "record_type": "A"}` (A, AAAA, CNAME, MX, TXT or NS), `multistep` `{"steps": [{"name": ..., "method": ..., "url": ...}, ...]}`, `cron` `{"cron_expression": "*/5 * * * *"}`. `mcp` config is optional: `headers` (e.g. `{"Authorization": "Bearer ${MCP_TOKEN}"}`; read back as `[REDACTED]` like `http` headers), `expected_tools` (tool names that must exist), `drift_mode` (`alert_on_change` default, or `off`), `drift_scope` (`schemas` default, or `names`), `drift_severity` (`degraded` default, or `down`), `protocol_version` (`2025-11-25` default, `2025-06-18`, `2025-03-26`, `2024-11-05`), `strict_protocol_version`, `timeout` (ms, 1000-60000) and `verify_tls`. `dns` and `multistep` monitors need a plan that includes them. Check intervals are 15 to 900 seconds; your plan sets the minimum (see `sutramx whoami`).

Maintenance windows silence alerts, so creating, changing and deleting them is owner-only: the API refuses every API key (`403 WORKSPACE_OWNER_REQUIRED`), and the CLI only lists them. Manage them in the dashboard.

`plan`, `diff` and `apply` accept `-f, --file <path>` (default `sutramx.yml`), `--prune` / `--no-prune`, `--adopt-by-name`, `--prune-integrations`, `--workspace <id>` and `--json`. Nothing is ever deleted without `--prune` (monitors) or `--prune-integrations` (integrations) on the command line: `settings.prune` / `settings.prune_integrations` in the file only produce a warning. With `--detailed-exitcode`, `plan` and `diff` exit 0 when nothing would change, 2 when something would, 1 on error. `apply` shows the plan with the target workspace and asks for confirmation on a terminal (naming the workspace and how many monitors would be deleted or replaced and integrations deleted); in CI pass `--auto-approve` or `--yes` (without it a non-interactive apply is refused). `--allow-delete-all` lets a prune delete every managed monitor when the file declares none (otherwise refused).

`apply` applies exactly the plan it showed: it sends the plan's fingerprint, and if the workspace changed in between the API refuses (`409 PLAN_CHANGED`) and nothing is applied; run `apply` again to review the new plan. Against an older API that returns no plan fingerprint, a prune that would delete monitors is refused unless you pass `--force-prune-without-plan-check` (a prune that shows no deletes is applied without prune).

## sutramx.yml

```yaml
version: 1

defaults:                 # merged into every monitor
  interval_seconds: 60
  tags: [prod]

settings:
  prune: false            # true: plan/apply warn that --prune is needed; only `apply --prune` deletes
                          # keyed monitors that are not in this file (including ones created
                          # by Terraform or the MCP server)
  adopt_by_name: false    # true: first apply links existing monitors with the same name and type
  # workspace_id: ...     # optional: apply refuses deletes/replaces when the API key acts on another workspace

monitors:
  - key: homepage         # stable id, unique per workspace: letters, digits, . _ : / -
    name: Homepage
    url: https://example.com
    regions: [fra1, usa-az-probe]   # null = plan default; omit to leave as is
  - key: api-health
    name: API health
    type: api
    url: https://api.example.com/health
    config: { expected_status_codes: [200], timeout: 10000 }
  - key: nightly-backup
    name: Nightly backup
    type: cron
    config: { cron_expression: "0 2 * * *" }
    paused: false

status_pages:
  - slug: example-status  # matched by slug; never deleted by apply
    title: Example status
    is_public: true
    monitors: [homepage, { key: api-health, section: API }]

integrations:             # needs an Automation access key
  - name: Ops Slack       # matched by type + name
    type: slack
    config:
      webhook_url: ${SLACK_WEBHOOK_URL}
    routing:
      scope: monitors     # or: all
      monitors: [homepage, api-health]
```

How it reconciles:

- **Monitors** are matched by `key` and planned by the SutramX API with the same rules as the dashboard (plan limits, minimum interval, allowed locations, URL safety). A field you leave out is not managed: an existing monitor keeps its value. `config`, when present, is managed as a whole. Changing `type` shows as a **replace** (delete, then create: the old monitor's history goes); `apply` refuses it unless you pass `--allow-replace` (or `--prune`). Monitors without a key (made in the dashboard) are never changed unless you adopt them.
- **Status pages** are created or updated; monitors are listed in order with optional sections. Delete pages in the dashboard.
- **Integrations** are created or updated (secrets are stored encrypted and only read back masked, so a secret counts as changed when its visible tail differs). With `--prune-integrations`, connections of the declared types that are not in the file are deleted. Names are compared as SutramX stores them (trimmed, runs of spaces collapsed). Routing to a monitor key that is neither in the file nor in the workspace is an error, not silently dropped.
- `${VAR}` and `${VAR:-default}` read environment variables; a missing variable is an error. `$${VAR}` is a literal. In CI (`CI` or `GITHUB_ACTIONS` set) only variables listed in `SUTRAMX_ALLOWED_ENV` can be read (see [Security guardrails](#security-guardrails)). Output (plan, diff, `--json`, errors) shows an expanded value as `${VAR}`, never the value.

Apply order: monitors first, then integrations and status pages, so new monitors can be referenced by key in the same run. Apply stops at the first failure (completed changes are kept) unless `--continue-on-error`. `plan` warns when the plan's monitor allowance or minimum interval would make apply fail, and apply refuses to start when the file changes integrations but the key lacks Automation access.

### Moving an existing workspace to code

```bash
sutramx init --from-workspace   # writes keys for every monitor (browser checks are skipped: they stay in the dashboard), with adopt_by_name: true
sutramx plan                    # should only show the links
sutramx apply
```

## GitHub Actions

`action/action.yml` is a composite action; `examples/github-workflow.yml` posts the plan on pull requests and applies on merge to `main`:

```yaml
- uses: sutramx/cli/action@v1
  with:
    command: apply        # plan | diff | apply
    api-key: ${{ secrets.SUTRAMX_API_KEY }}
```

If `sutramx.yml` uses `${VAR}`, list those variables in `allowed-env` (or set `SUTRAMX_ALLOWED_ENV` in the workflow): in CI nothing else can be read.

```yaml
- uses: sutramx/cli/action@v1
  with:
    command: plan
    api-key: ${{ secrets.SUTRAMX_API_KEY }}
    allowed-env: STAGING_URL,SLACK_*
  env:
    STAGING_URL: ${{ vars.STAGING_URL }}
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Outputs: `has-changes` and `plan` (the text output). The plan is also written to the job summary.

`cli-version` defaults to the CLI release the action ships with (the `version` in `package.json`; every release bumps both together), so a new npm release never changes what an existing workflow runs. Set an exact version to pin it yourself, or `cli-version: latest` to opt in to following every release. Pin the action itself to a full commit SHA (`uses: sutramx/cli/action@<sha>`) for the strongest guarantee.

## API used

`GET /automation/whoami`, `POST /automation/monitors/plan`, `POST /automation/monitors/apply`, `GET|PUT|DELETE /automation/monitors/:key`, `PUT /automation/monitors/by-id/:id/key`, plus the regular `/monitors` (including `/:id/checks`, `/:id/run-check`, `/:id/regions`), `/incidents` (list, get, acknowledge, resolve, notes), `/maintenance` (list), `/status/pages`, `/reliability` (overview, monitor), `/integrations` and `/catalog/regions` endpoints.

## Development

```bash
npm install
npm run build
npm test
node dist/index.js --help
```

## License

MIT, see [LICENSE](LICENSE).

## Security guardrails

- **API URL**: `--api-url` / `SUTRAMX_API_URL` must be `https://` (plain `http://` only for `localhost`). A warning is printed when the key is sent to a host outside `sutramx.com`, or when `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate checks. Redirects are never followed.
- **Key handling**: prefer `echo "$KEY" | sutramx login` or the hidden prompt over `--api-key` (visible in `ps` and shell history). The credentials file is written `0600` via an exclusive temp file and rename (a symlink at the path is replaced, not followed); a warning is printed if it becomes readable by others.
- **`${VAR}` in sutramx.yml**: the file may not read `SUTRAMX_API_KEY`, `SUTRAMX_CONFIG`, `GITHUB_TOKEN`, `GH_TOKEN`, `ACTIONS_*`, `INPUT_*`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `CI_JOB_TOKEN`, `CI_JOB_JWT*` or `SYSTEM_ACCESSTOKEN`, so a pull request cannot copy credentials into a monitor or into the plan comment. Set `SUTRAMX_ALLOWED_ENV="SLACK_*,PAGERDUTY_KEY"` to allow only the listed variables (names, or prefixes ending in `*`). **In CI** (`CI` or `GITHUB_ACTIONS` set to anything but `false`/`0`) the default flips: with no `SUTRAMX_ALLOWED_ENV` (the action's `allowed-env` input), `${VAR}` reads nothing, because a pull request could otherwise reference any other secret in the runner's environment. Keep the allowlist in the workflow, not in a file the pull request can change. Values read through `${VAR}` (4+ characters) are printed as `${VAR}` in plan/diff/apply output, `--json` and error messages, never as the value; they are still sent to the API.
- **Plan output**: integration config values whose names look like credentials (`*url*`, `*token*`, `*secret*`, `*key*`, ...) are shown as `(secret, not shown)` in `plan`, `diff` and `--json`.
- **Deletes**: only with `--prune` / `--prune-integrations` on the command line, never from the file alone. `apply` with prune refuses to delete every managed monitor when the file declares none (an empty or truncated file); pass `--allow-delete-all` if that is intended. `monitors delete` and `incidents note --public` ask first unless `--yes`.
- **Plan = apply**: `apply` sends the fingerprint of the plan it showed; the API refuses a changed plan (`409 PLAN_CHANGED`). Status page and integration changes are planned once, shown, and applied only if they are still the ones shown.
- **Workspace scope**: a key only ever acts on its own workspace, and `plan` / `apply` print which one. When that workspace differs from the one saved by `sutramx login` (e.g. `SUTRAMX_API_KEY` set for another workspace) or from `settings.workspace_id`, `apply` refuses deletes and replaces unless `--workspace <id>` names the key's workspace (and `--workspace` always refuses a key for another workspace); the CLI takes the API URL only from `--api-url`, `SUTRAMX_API_URL` or the credentials file, never from `sutramx.yml`. The key is never printed.
- **Retries**: 429 answers are retried (honouring `Retry-After`, at most 4 attempts); 502/503/504 and network errors are retried only for GET/PUT/DELETE.
- **GitHub Action**: the key is masked with `::add-mask::`, `cli-version` must be a registry version or tag, and inputs reach the script only through environment variables. `cli-version` defaults to the exact release the action ships with (`latest` is opt-in only), and `actions/setup-node` is pinned to a full commit SHA.
