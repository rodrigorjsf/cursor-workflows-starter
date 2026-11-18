# Dashboard verification map

Maintained source for the user-facing behavior of the local Cursor Workflows dashboard. Read this index, then the feature file. The procedures live in `../SKILL.md`.

## Baseline preconditions

- Launch with `.cursor/skills/verify-dashboard/verify-dashboard.sh up`.
- Doctor exits 0. The instance is the `url` in `.cursor/skills/verify-dashboard/state/current.json`, not port 4317.
- Fixture runs exist: `ship-feature` finished (`#128 Add a dark mode toggle to the settings page`), failed (`#131 Paginate the audit log API`), cancelled (`#136 Rate-limit the login endpoint`), and interrupted (`#140 Migrate the session store to Redis`, shown as failed).
- Run ids are `runs.finished`, `runs.failed`, `runs.cancelled`, and `runs.interrupted` in `fixtures.json`.
- Chrome DevTools uses `isolatedContext` from the record. Playwright uses `scripts/dev/dash-shots.py` against the same URL.
- Never drive a dashboard this verification run did not start.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Prefer the accessible name in the latest `take_snapshot` over CSS selectors or screen coordinates.
- Treat commands, labels, and route hashes as literal.
- Hash routes: `#/runs`, `#/board`, `#/metrics`. The Run view is `/runs/<runId>` (no hash).
- The empty hash opens the Board.
- Restore nothing in the fixture home during the drive. `down` deletes that home. Keep proof files.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Chrome DevTools proof is a snapshot file and a screenshot saved under `<evidence>/<feature>/`.
- Playwright proof is `<evidence>/playwright/` (`probes.json` and the PNGs). One `dash-shots.py` run covers Runs, Board, Metrics, and the Run views. It does not replace a click a feature file names.
- Read proof includes the JSON of the API the page polls.
- Record the feature id, the entry URL, and the run id in `notes.txt`.
- Report an unreachable path with the attempted tool call and the unmet precondition.
- Do not report a skipped entry as verified through a different path.

## Feature entry contract

Each feature file has an H1, one paragraph, then four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with chrome-devtools and Playwright`, `Gotchas`.

## Features

- [Runs](./runs.md) lists every fixture run and opens the finished one.
- [Board](./board.md) shows the `ship-feature` columns and the finished, failed, and cancelled cards.
- [Run view](./run-view.md) draws the finished run, opens the `review` log, and starts Replay.
- [Metrics](./metrics.md) shows the fixture window and switches it to 7 days.
- [Start panel](./start-panel.md) opens and closes the form for the fixture repository without starting a job.
