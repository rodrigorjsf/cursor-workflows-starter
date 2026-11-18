# Runs

The Runs menu lists every run of every repository the dashboard knows, newest first, and opens a run in the Run view.

## Sub-features

- `runs-open` shows the Runs table from the menu.
- `runs-statuses` shows the finished, failed, cancelled, and interrupted fixture runs.
- `runs-open-run` opens the finished run from its id link.

## How to get to it (user POV)

- Choose `Runs` in the header menu.
- Open `#/runs`.

## Driving it with chrome-devtools and Playwright

Preconditions:

- Doctor exited 0.
- `fixtures.json` has `runs.finished`, `runs.failed`, `runs.cancelled`, and `runs.interrupted`.
- The page to open is `<url>/#/runs`.

Chrome DevTools uses the same names via `new_page`, `wait_for`, `take_snapshot`, and `click` on the uid. When `list_pages` fails, run the Playwright commands.

- **Menu entry.** `drive.py goto --path /#/runs`, then `drive.py wait --text Runs`, then `drive.py wait --text ship-feature`, then `drive.py snapshot --path <evidence>/runs/list.a11y.txt`, then `drive.py title`. The title is `Runs · Cursor Workflows`. The snapshot heading is `Runs`.
- **Statuses.** `drive.py count --text finished` prints `1`. `drive.py count --text failed` prints `2`. `drive.py count --text cancelled` prints `1`. `drive.py contains --text <runs.finished>` and the same for `runs.failed`, `runs.cancelled`, and `runs.interrupted`. There is no status text `interrupted`.
- **Second view.** `GET <url>/api/runs` saved to `<evidence>/runs/api-runs.json` contains those four ids. `interrupted` is `failed` in that JSON.
- **Open the finished run.** `drive.py click --role link --name <runs.finished>`, then `drive.py wait --text ship-feature`, then `drive.py url`, then `drive.py snapshot --path <evidence>/runs/opened.a11y.txt`, then `drive.py screenshot --path <evidence>/runs/opened.png`. The URL path is `/runs/<runs.finished>`. The snapshot contains `ship-feature`, the finished id, `finished`, and the breadcrumb `Runs`.
- **Playwright screenshots.** Run the `dash-shots.py` command from the skill. `<evidence>/playwright/runs-1440-light.png` exists and `probes.json` has a `runs-1440-light` entry. That command also captures the other pages; it does not replace the click above.

## Gotchas

- The interrupted run is listed as `failed`. Do not look for a status named `interrupted`.
- A run with status `missing` shows the id as text, not as a link. The fixture runs are not missing.
- The table polls `/api/runs` every 3 seconds. Wait for `ship-feature`, not a fixed sleep.
- The id link's accessible name is the run id. The workflow name `ship-feature` is a separate text node.
- Opening a run leaves the hash menu. Return with the `Runs` breadcrumb or `#/runs` before proving the list again.
