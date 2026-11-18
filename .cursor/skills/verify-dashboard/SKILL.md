---
name: verify-dashboard
description: Drive the local Cursor Workflows dashboard (the web UI on 127.0.0.1) and prove Runs, the Board, Metrics, a Run view, and the Start panel. Use after a dashboard change, before calling dashboard UI work done, or when a page needs captured evidence. Does not drive the wf CLI or the workflows MCP server.
---

# Verify the dashboard

The dashboard is the web UI (`npm run dash`). The `wf` CLI and the `workflows` MCP server are separate surfaces; this skill does not drive them. Token-costing probes stay in `scripts/verify/README.md`.

Two harnesses. Try Chrome DevTools first. When it does not answer, drive the same steps with Playwright. Do not skip the feature.

- **Chrome DevTools MCP** (`list_pages`, `new_page`, `select_page`, `take_snapshot`, `click`, `fill`, `wait_for`, `take_screenshot`, `evaluate_script` read-only). Discover the schema before calling. `click` and `fill` take a `uid` from the latest `take_snapshot`. A uid from an older snapshot is stale. `list_pages` first. If it fails, including `Protocol error (Target.setDiscoverTargets): Target closed`, do not retry and do not touch port 4317. Use Playwright for every step.
- **Playwright** clicks and reads through `drive.py` (commands below). `scripts/dev/dash-shots.py` (Playwright 1.65.1 via `uvx`) screenshots Runs, Board, Metrics, and every Run view. It does not click. Run it once per proof, after the click steps.

Never drive port **4317** or `~/.cursor-workflows`. That is the user's dashboard. Two verification instances can run at once only with different `WF_HOME` values and different ports, each with its own `current.json` (`VERIFY_DASH_STATE_DIR`). One record at a time is the default.

Open `http://127.0.0.1:<port>`, never `localhost`. On WSL2, `localhost` is refused from Windows Chrome.

## Launch

From the repo root, with dependencies installed (`mise exec -- npm ci --prefer-offline` when `node_modules/.bin/tsx` is missing):

```bash
.cursor/skills/verify-dashboard/verify-dashboard.sh up
```

`up` is ready when it prints `current.json` and stderr says `ready http://127.0.0.1:<port>`. Ready means `/api/health` returned and the log contains `dashboard listening on http://127.0.0.1:<port> (metrics database: <home>/metrics.db)` plus `web app built (`. The fixture home is not empty of runs: `scripts/dev/dash-fixtures.ts` has written four runs (finished, failed, cancelled, interrupted) through the real engine and the fake SDK. It does not call the Cursor API and does not touch `~/.cursor-workflows`.

The record is `.cursor/skills/verify-dashboard/state/current.json` (gitignored):

- `url`, `port`, `pid`, `home`, `fixtures` (`<home>/fixtures.json`), `evidence`, `isolatedContext`

Run ids come from `fixtures.json` (`runs.finished`, `runs.failed`, `runs.cancelled`, `runs.interrupted`). They change every `up`.

Once per machine, if Playwright has no browser yet:

```bash
uvx --with playwright==1.65.1 playwright install chromium
```

Teardown is `verify-dashboard.sh down`. Run it after every attempt, including a failed one, so the port and the fixture home do not stay behind.

## Doctor

```bash
.cursor/skills/verify-dashboard/verify-dashboard.sh doctor
```

Run doctor before driving, and again whenever the page looks wrong. It is read-only. It exits 0 only when all of these hold:

- the process `pid` is alive
- `GET /api/health` is `{"app":"cursor-workflows-dashboard","pid":<that pid>}`
- `port` is not 4317
- `WF_HOME`, `WF_DASH_PORT`, `WF_METRICS_DB` (`<home>/metrics.db`), and `WF_DASH_AUTOSTART=off` on that process match the record
- `<home>/dashboard.pid` names the same pid and port
- the log has the listening line and the web-bundle line
- `fixtures.json` has the four run roles
- the home is not `~/.cursor-workflows`

Stdout names the four run ids. Copy it to `<evidence>/doctor.txt`. If doctor fails, do not drive. `down`, then `up` again.

## Drive

Read `features/README.md`, then the feature file. Start from the fixture baseline unless that file says otherwise.

Chrome DevTools, when `list_pages` answers:

1. Ignore any tab whose URL is not `url` from `current.json`.
2. `new_page` with `url` set to the page in the feature file and `isolatedContext` set to `isolatedContext` from the record. Then `select_page` that page.
3. `wait_for` the text the feature names. The Runs list polls every 3s, the Board every 2s, Metrics every 30s. Wait for the text, not a fixed sleep.
4. `take_snapshot`. Find the control by its accessible name. `click` or `fill` that uid. Snapshot again after the click.
5. `evaluate_script` may read `document.title` or visible text. It must not assign, click, or call `fetch` to a mutating route.

Playwright, when Chrome DevTools does not answer. Same accessible names:

```bash
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py <subcommand>
```

`goto --path <path>` opens `<url><path>`. Then `wait --text`, `click --role --name` (exact), `click --role --name-regex` (a Python regex, for names that include a state), `fill --role --name --value`, `select --name --value` (combobox option value), `snapshot --path`, `screenshot --path`, `title`, `url`, `count --text`, `contains --text`, `close`. The first command starts headless Chromium and keeps it until `close` or `down`.

`dash-shots.py`, once per proof, after those steps:

```bash
uvx --with playwright==1.65.1 python -I scripts/dev/dash-shots.py \
  "$URL" "$EVIDENCE/playwright" \
  --fixtures "$FIXTURES"
```

`$URL` is `url` without a trailing slash. `$FIXTURES` is `fixtures`. `$EVIDENCE` is `evidence`. Add `--browser <chrome-or-chromium>` only when Playwright's own browser will not launch. `--strict` exits 1 on horizontal overflow or a console error; a strict failure is a failed proof.

Do not submit the Start panel's **Start** button. That starts a real job with the real SDK and spends the Cursor account. The header button that opens the panel is safe.

## Evidence

Write proof under `evidence` from `current.json` (`.cursor/skills/verify-dashboard/evidence/<id>/`, gitignored). `down` does not delete that directory.

| Proof | Where |
|---|---|
| Doctor | `<evidence>/doctor.txt` and `<evidence>/doctor-health.json` |
| Click and the state after it | `<evidence>/<feature>/` snapshot (Chrome `take_snapshot` `filePath`, or `drive.py snapshot`) plus a PNG (`take_screenshot` or `drive.py screenshot`) |
| Playwright | `<evidence>/playwright/*.png` and `probes.json` |

Standards:

- Exercise the page a person uses (`#/runs`, `#/board`, `#/metrics`, `/runs/<runId>`, the Start panel). Do not prove a screen by writing the runs index or the metrics database yourself.
- Capture the action and the state after it. A screenshot of the final screen alone is not the proof.
- Pair the screen with the read API the page uses (`/api/runs`, `/api/board`, `/api/summary`, `/api/runs/<id>`). A status pill without the matching JSON is not enough.
- The fixture runs are the seed. `dash-fixtures.ts` already isolates the Cursor API behind the fake SDK. Do not add another mock.
- Record the feature id, the entry URL, and the run id in a `notes.txt` next to the artifacts.
- An unreachable entry stays failed. Name the command and the missing precondition. Do not mark it verified through another entry.

## Cleanup

```bash
.cursor/skills/verify-dashboard/verify-dashboard.sh down
```

`down` sends SIGTERM to the dashboard pid in `current.json`, SIGKILL only if that pid is still alive, and SIGTERM to the `drive.py --serve` pid in `.cursor/skills/verify-dashboard/state/browser.json` when the command line is that server. It deletes the `/tmp/verify-dashboard-home-*` directory it created. It does not kill by process name. It does not remove `evidence/` or `state/`. If Chrome DevTools opened a tab, `close_page` that page after the screenshots are on disk. The tool cannot close the last open page. Do not close tabs whose URL is not this instance.

After `down`, `test -f <evidence>/<feature>/*.png` and `test -f <evidence>/playwright/probes.json` must still succeed.

## Helpers

| Script | Invocation |
|---|---|
| `verify-dashboard.sh` | `.cursor/skills/verify-dashboard/verify-dashboard.sh up` · `doctor` · `down` |
| `scripts/dev/dash-fixtures.ts` | called by `up`; do not point it at `~/.cursor-workflows` |
| `drive.py` | `uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py <subcommand>` |
| `scripts/dev/dash-shots.py` | the Playwright screenshot command in Drive |
