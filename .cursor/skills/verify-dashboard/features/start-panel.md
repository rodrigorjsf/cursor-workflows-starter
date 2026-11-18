# Start panel

The Start panel picks a repository the dashboard already knows, a workflow of that repository, JSON args, and both caps. Submitting starts a job. Verification opens and closes the panel and does not submit.

## Sub-features

- `start-open` opens the panel from the header button.
- `start-repo` shows the fixture repository `web-app` and a workflow list.
- `start-close` closes the panel and leaves no job running.

## How to get to it (user POV)

- Choose the header button `Start` (accessible name `Start a workflow`) on Runs, Board, or Metrics.
- A Backlog card's `run` button opens the same panel with the issue filled in. The fixture board has no Backlog card, so that entry is not in this baseline. Do not invent an issue to force it.

## Driving it with chrome-devtools and Playwright

Preconditions:

- Doctor exited 0.
- The page to open is `<url>/#/board`.
- No job is running. `up` does not pass `--live`.

Playwright, when Chrome DevTools does not answer. Do not click the submit button named `Start`.

```bash
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py goto --path /#/board
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text Board
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role button --name "Start a workflow"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text Repository
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text implement-issue
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/start-panel/open.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py screenshot --path <evidence>/start-panel/open.png
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role button --name Close
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/start-panel/closed.a11y.txt
```

After Close, `drive.py contains --text "Start a workflow"` still matches the header button, and the heading `Start a workflow` is gone from the snapshot file.

- **Open.** `new_page` with `url` `<url>/#/board` and `isolatedContext` from the record. `wait_for` text `Board`. `take_snapshot`. `click` the uid of the button named `Start a workflow` (the header one, not a button named only `Start` inside a form). `wait_for` text `Start a workflow` and `Repository`. `take_snapshot` to `<evidence>/start-panel/open.a11y.txt`. A region is named `Start a workflow`. The heading is `Start a workflow`. A listbox is named `Repository`. Its shown value contains `web-app`. A listbox is named `Workflow`. A textbox is named `Args (JSON)`. Spin buttons are named `maxTokens` and `maxCents`. Buttons named `Start` and `Close` are in the region.
- **Workflow list.** `wait_for` text `implement-issue` (the built-in list loads after the repository is chosen). The Workflow listbox is enabled and includes `implement-issue`. `take_screenshot` `filePath` `<evidence>/start-panel/open.png`.
- **No job.** `GET <url>/api/runs` saved to `<evidence>/start-panel/api-runs.json` contains the four fixture ids and no run whose `status` is `running`.
- **Close.** `click` the button named `Close`. `take_snapshot` to `<evidence>/start-panel/closed.a11y.txt`. The region `Start a workflow` is gone. The header button `Start a workflow` has `aria-expanded` false (`evaluate_script` may read that attribute). The Board heading is still `Board`.
- **Do not submit.** Do not `click` the form button named `Start`. Do not `fill` caps and submit. That calls the real Cursor SDK.

## Gotchas

- Two controls say Start. The header button's accessible name is `Start a workflow`. The form submit button's name is `Start`. Clicking the submit spends the account.
- The repository label in the list is the directory name `web-app`, not the full path. The note under the list shows the full path.
- The panel lists workflows only for a repository that already has a run. The fixture repository qualifies. An empty dashboard shows `No repository to start a workflow in`.
- Escape closes the panel. A second snapshot after Escape must match the Close result.
- The Backlog `run` button is a different entry. Without a listed issue, skip it and say the fixture forge did not return a card. Do not file a fake issue.
