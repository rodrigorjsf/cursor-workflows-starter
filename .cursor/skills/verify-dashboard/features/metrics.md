# Metrics

Metrics shows cost and efficiency for a window of days. The fixture runs write the metrics database the page reads.

## Sub-features

- `metrics-open` shows the Metrics page for the default 30-day window.
- `metrics-window` switches the window to 7 days and keeps the fixture workflow on screen.
- `metrics-empty` is the sentence the page shows when the selected window has no rows. The fixture window is not empty; do not treat the fixture page as the empty state.

## How to get to it (user POV)

- Choose `Metrics` in the header menu.
- Open `#/metrics`.

## Driving it with chrome-devtools and Playwright

Preconditions:

- Doctor exited 0.
- The page to open is `<url>/#/metrics`.

Playwright, when Chrome DevTools does not answer:

```bash
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py goto --path /#/metrics
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text "Daily spend by workflow"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text ship-feature
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/metrics/metrics-30.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py select --name Window --value 7
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text "Last 7 days"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/metrics/metrics-7.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py screenshot --path <evidence>/metrics/metrics-7.png
```

`select` sets the option value `7`, which the list shows as `Last 7 days`.

- **Menu entry.** `new_page` with `url` `<url>/#/metrics` and `isolatedContext` from the record. `wait_for` text `Daily spend by workflow` and `ship-feature`. `take_snapshot` to `<evidence>/metrics/metrics-30.a11y.txt`. The heading is `Metrics`. The document title is `Metrics · Cursor Workflows`. A listbox named `Window` shows `Last 30 days`. An image is named `Daily spend by workflow`. The table contains `ship-feature`.
- **Second view.** `GET <url>/api/summary?days=30` saved to `<evidence>/metrics/api-summary-30.json` has a `workflows` row whose `workflow` is `ship-feature`. The `totals` row has a `runs` count greater than 0.
- **7-day window.** `fill` the uid of the `Window` listbox with value `7`. `wait_for` text `Last 7 days`. `take_snapshot` to `<evidence>/metrics/metrics-7.a11y.txt` and `take_screenshot` `filePath` `<evidence>/metrics/metrics-7.png`. The listbox value is `Last 7 days`. `ship-feature` is still on the page. `GET <url>/api/summary?days=7` saved to `<evidence>/metrics/api-summary-7.json` still names `ship-feature`.

## Gotchas

- The option value is `7`, `30`, `90`, or `365`. The visible label is `Last 7 days`. `fill` the select with `7`, not with the visible label.
- The default window is 30 days. Fixture runs are dated now, so they fall inside 7 and 30.
- Metrics polls every 30 seconds. After `fill`, wait for `Last 7 days` and then read `/api/summary?days=7`. Do not assert the 30-day JSON against the 7-day screen.
- An empty window shows the heading `No metrics in this window`. Seeing that on a fixture instance means the dashboard is reading the wrong database. Stop and run doctor.
- Charts are SVG. The accessible name of the daily chart is `Daily spend by workflow`. There is no chart library canvas.
