# Changelog

All notable changes to `@sutramx/cli` are listed here. Releases are the `vX.Y.Z` git tags and the versions on npm.

## 0.2.0 (October 13, 2026)

### Changed

- **Exit codes.** Errors now exit with a code that says what went wrong: `3` authentication or permission (not logged in, HTTP 401/403), `4` not found (HTTP 404), `5` rate limited (HTTP 429), `6` network failure or timeout, `7` plan limit (retrying will not help), `8` usage or validation (unknown command or option, invalid argument, invalid `sutramx.yml`, HTTP 400/422). `0` and `2` (`plan` / `diff --detailed-exitcode`: something would change) are unchanged, and `1` stays the code for any other error. Scripts that test for exactly `1` on failure should test for "not 0 and not 2" instead.
- Login and confirmation prompts write to stderr, so stdout stays clean for `--json` and pipes.
- Warnings the API returns with a change (for example an ignored field) are printed on stderr.
- The Arizona, USA monitoring location code is now `usa-az` (`sutramx regions` lists it). The earlier code still works with `--region` and in `sutramx.yml`; the API saves and returns it as `usa-az`, so `plan` shows no change for a file that still uses it. Examples use `usa-az`.

### Added

- `SUTRAMX_TIMEOUT`: seconds to wait for each request attempt. Default 20, and 120 for `plan`, `apply` and `monitors run-check`. A call gives up, retries included, after three times this.
- Proxy support: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (or lower case). Behind a TLS-inspecting proxy, point `NODE_EXTRA_CA_CERTS` at its CA certificate.
- Requests send `X-SutramX-Client: sutramx-cli/<version>` next to the `User-Agent`.
- `sutramx --help` lists the environment variables and exit codes.

### Fixed

- **Retries never run an action twice.** Every `POST` carries an `Idempotency-Key` that its retries reuse. The creates the API runs once per key (monitors, monitor groups, status pages and their monitors, integration connections, incidents, runbooks, incident notes, maintenance windows, `apply`) and the read-only `plan` are retried like reads: on network errors, timeouts and HTTP 502/503/504. A `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` answer (the first try is still running) waits and asks again with the same key. Any other `POST` (acknowledge, resolve, run-check, pause, resume, test ...) is sent once after a network error, a timeout or a 5xx, and the error is reported, since a retry could run it twice.
- HTTP 429 is retried for every request, actions included (the API refuses it before running it). `Retry-After` is read as seconds or as an HTTP date; a wait longer than 30 seconds is reported instead of slept through. Each retry prints a note on stderr.
- Plan limits (`category: PLAN_LIMIT` and every limit code, also when sent as 429) are never retried and say that retrying will not help.
- A network failure names its cause and the host (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, certificate errors) instead of `HTTP 0`.
- A response that is not JSON (a proxy or captive portal page) or is larger than 10 MB is reported as an error that names the likely cause.
- A plain-text 429 body is shown as the error message.

## 0.1.4 (October 10, 2026)

- `sutramx why <monitor|incident-id>`: why a monitor is down or why an alert fired.

## 0.1.3 (October 10, 2026)

- `${VAR}` in `sutramx.yml` reads only allow-listed variables, and expanded values are never printed.
- The GitHub Action and the example workflow pin their dependencies to commit SHAs.

## 0.1.2 (October 6, 2026)

- `mcp` monitor type (remote MCP server checks) in `monitors create` and `sutramx.yml`.
- Published from GitHub Actions with npm Trusted Publishing.

## 0.1.1 (October 6, 2026)

- `apply` applies only the plan it showed and deletes only with `--prune`; new monitor, status page, uptime and note commands.
- `apply` treats a monitor type change (replace) as destructive and shows the target workspace.

## 0.1.0 (October 3, 2026)

First public release: monitors, incidents and maintenance from the command line, monitors as code with `sutramx.yml`, and the GitHub Action.

Earlier detail: see the git history.
