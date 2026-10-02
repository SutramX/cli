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
| `sutramx login` | saves the key to `~/.config/sutramx/credentials.json` (mode 0600; `$XDG_CONFIG_HOME` and `$SUTRAMX_CONFIG` are honoured) |

A key acts on the one workspace it was created in. Keys have one of three access levels, chosen when the key is created: **Read-only** (`whoami`, `monitors list|get`, `incidents list|get`, `maintenance list`, `regions`, `init --from-workspace`, `plan` and `diff` work; `apply`, `monitors create|pause|resume|delete|adopt`, `incidents ack|resolve` and every other change are refused with `403 READ_ONLY_ACCESS`; use it for CI jobs that only post the plan), **Standard** and **Automation**. A standard key can manage monitors and status pages. To manage **integrations** from `sutramx.yml`, create the key with **Automation access**. Per-monitor alert recipients (`config.notification_emails`) also need an Automation access key; a standard key gets a clear error instead of a change that never applies.

## Commands

| Command | |
|---|---|
| `sutramx login [--api-key sk_...]` / `logout` | save or remove the key |
| `sutramx whoami` | workspace, plan and limits |
| `sutramx monitors list [--tag t] [--status down] [--json]` | monitors with live status |
| `sutramx monitors get <id or key>` | one monitor as JSON |
| `sutramx monitors create --name N --url U [--type api] [--interval 60] [--region bom --region sin] [--tag prod] [--config '{...}'] [--key k] [--paused]` | create (with `--key`: create or update) |
| `sutramx monitors pause|resume <id>` | stop or restart checks |
| `sutramx monitors delete <id> [--yes]` | delete with its history |
| `sutramx monitors adopt <id> <key>` | let `sutramx.yml` manage an existing monitor |
| `sutramx incidents list [--status ongoing] [--monitor <id or key>] [--search t] [--from 2026-10-01] [--to ...] [--page 2] [--page-size 50] [--json]` | incidents, newest first (`--status`: all, ongoing, resolved, acknowledged, suppressed) |
| `sutramx incidents get <id> [--json]` | one incident (`--json` includes the timeline) |
| `sutramx incidents ack <id>` | acknowledge an ongoing incident (stops escalation) |
| `sutramx incidents resolve <id> [--note "what was done"]` | resolve by hand; fails with `409 INCIDENT_RESOLVED` if already resolved |
| `sutramx maintenance list [--status ongoing] [--json]` | maintenance windows with their scope and recurrence |
| `sutramx regions` | probe location codes |
| `sutramx init [--from-workspace]` | write a starter `sutramx.yml`, or one describing what exists now |
| `sutramx validate` | check the file locally |
| `sutramx plan [--detailed-exitcode]` | what `apply` would change |
| `sutramx diff` | the plan with every field shown old -> new |
| `sutramx apply [--auto-approve] [--continue-on-error]` | make SutramX match the file |

Maintenance windows silence alerts, so creating, changing and deleting them is owner-only: the API refuses every API key (`403 WORKSPACE_OWNER_REQUIRED`), and the CLI only lists them. Manage them in the dashboard.

`plan`, `diff` and `apply` accept `-f <file>`, `--prune` / `--no-prune`, `--adopt-by-name`, `--prune-integrations` and `--json`. With `--detailed-exitcode`, `plan` exits 0 when nothing would change, 2 when something would, 1 on error.

## sutramx.yml

```yaml
version: 1

defaults:                 # merged into every monitor
  interval_seconds: 60
  tags: [prod]

settings:
  prune: false            # true: delete monitors that have a key but are not in this file
                          # (including keyed monitors created by Terraform or the MCP server)
  adopt_by_name: false    # true: first apply links existing monitors with the same name and type

monitors:
  - key: homepage         # stable id, unique per workspace: letters, digits, . _ : / -
    name: Homepage
    url: https://example.com
    regions: [bom, sin]   # null = plan default; omit to leave as is
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

- **Monitors** are matched by `key` and planned by the SutramX API with the same rules as the dashboard (plan limits, minimum interval, allowed locations, URL safety). A field you leave out is not managed: an existing monitor keeps its value. `config`, when present, is managed as a whole. Changing `type` shows as a **replace** (delete, then create: the old monitor's history goes). Monitors without a key (made in the dashboard) are never changed unless you adopt them.
- **Status pages** are created or updated; monitors are listed in order with optional sections. Delete pages in the dashboard.
- **Integrations** are created or updated (secrets are stored encrypted and only read back masked, so a secret counts as changed when its visible tail differs). With `--prune-integrations`, connections of the declared types that are not in the file are deleted.
- `${VAR}` and `${VAR:-default}` read environment variables; a missing variable is an error. `$${VAR}` is a literal.

Apply order: monitors first, then integrations and status pages, so new monitors can be referenced by key in the same run. Apply stops at the first failure (completed changes are kept) unless `--continue-on-error`. `plan` warns when the plan's monitor allowance or minimum interval would make apply fail, and apply refuses to start when the file changes integrations but the key lacks Automation access.

### Moving an existing workspace to code

```bash
sutramx init --from-workspace   # writes keys for every monitor, with adopt_by_name: true
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

Outputs: `has-changes` and `plan` (the text output). The plan is also written to the job summary.

## API used

`GET /automation/whoami`, `POST /automation/monitors/plan`, `POST /automation/monitors/apply`, `GET|PUT|DELETE /automation/monitors/:key`, `PUT /automation/monitors/by-id/:id/key`, plus the regular `/monitors`, `/incidents` (list, get, acknowledge, resolve), `/maintenance` (list), `/status/pages`, `/integrations` and `/catalog/regions` endpoints.

## Development

```bash
npm install
npm run build
npm test
node dist/index.js --help
```

## Releasing

Bump `version` in `package.json` and `src/version.ts`, commit, then push a tag `v<version>`. `.github/workflows/release.yml` checks that the tag matches both, runs typecheck, tests and build, and publishes to npm with provenance (needs the `NPM_TOKEN` repository secret). `npm pack --dry-run` shows exactly what will be published.

## License

MIT, see [LICENSE](LICENSE).

## Security guardrails

- **API URL**: `--api-url` / `SUTRAMX_API_URL` must be `https://` (plain `http://` only for `localhost`). A warning is printed when the key is sent to a host outside `sutramx.com`, or when `NODE_TLS_REJECT_UNAUTHORIZED=0` disables certificate checks. Redirects are never followed.
- **Key handling**: prefer `echo "$KEY" | sutramx login` or the hidden prompt over `--api-key` (visible in `ps` and shell history). The credentials file is written `0600` via an exclusive temp file and rename (a symlink at the path is replaced, not followed); a warning is printed if it becomes readable by others.
- **`${VAR}` in sutramx.yml**: the file may not read `SUTRAMX_API_KEY`, `SUTRAMX_CONFIG`, `GITHUB_TOKEN`, `GH_TOKEN`, `ACTIONS_*`, `INPUT_*`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `CI_JOB_TOKEN`, `CI_JOB_JWT*` or `SYSTEM_ACCESSTOKEN`, so a pull request cannot copy credentials into a monitor or into the plan comment. Set `SUTRAMX_ALLOWED_ENV="SLACK_*,PAGERDUTY_KEY"` to allow only the listed variables.
- **Plan output**: integration config values whose names look like credentials (`*url*`, `*token*`, `*secret*`, `*key*`, ...) are shown as `(secret, not shown)` in `plan`, `diff` and `--json`.
- **Mass deletes**: `apply` with prune refuses to delete every managed monitor when the file declares none (an empty or truncated file); pass `--allow-delete-all` if that is intended.
- **Retries**: 429 answers are retried (honouring `Retry-After`, at most 4 attempts); 502/503/504 and network errors are retried only for GET/PUT/DELETE.
- **GitHub Action**: the key is masked with `::add-mask::`, `cli-version` must be a registry version or tag, and inputs reach the script only through environment variables. Pin `cli-version` to an exact version in production.
