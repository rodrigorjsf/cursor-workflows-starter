# Board

The Board is one kanban per workflow. `ship-feature` has a column per phase plus Awaiting approval, Done, Failed, and Cancelled. Each run is a card that opens the Run view.

## Sub-features

- `board-open` shows the `ship-feature` board from the menu.
- `board-columns` places the finished card in Done, the failed and interrupted cards in Failed, and the cancelled card in Cancelled.
- `board-open-card` opens the finished card in the Run view.

## How to get to it (user POV)

- Choose `Board` in the header menu.
- Open `#/board`, or the site root (the empty hash is the Board).
- Choose the brand `Cursor Workflows`.

## Driving it with chrome-devtools and Playwright

Preconditions:

- Doctor exited 0.
- The page to open is `<url>/#/board`.

Playwright, when Chrome DevTools does not answer. `<evidence>` is the evidence directory from `current.json`.

```bash
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py goto --path /#/board
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text "Add a dark mode toggle to the settings page"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/board/board.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py title
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role link --name "#128 Add a dark mode toggle to the settings page"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py url
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/board/opened.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py screenshot --path <evidence>/board/opened.png
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py goto --path /#/board
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role link --name "Cursor Workflows"
```

The title after the first `goto` is `Board · Cursor Workflows`. The opened URL path is `/runs/<runs.finished>`. After the brand click the title is `Board · Cursor Workflows` again.

- **Menu entry.** `new_page` with `url` `<url>/#/board` and `isolatedContext` from the record. `wait_for` text `ship-feature` and `Add a dark mode toggle to the settings page`. `take_snapshot` to `<evidence>/board/board.a11y.txt`. The heading is `Board`. The document title is `Board · Cursor Workflows`. A region is named `ship-feature board`.
- **Columns.** The snapshot has groups named `Done: 1`, `Failed: 2`, and `Cancelled: 1`. Done contains the link `#128 Add a dark mode toggle to the settings page`. Failed contains `#131 Paginate the audit log API` and `#140 Migrate the session store to Redis`. Cancelled contains `#136 Rate-limit the login endpoint`.
- **Second view.** `GET <url>/api/board` saved to `<evidence>/board/api-board.json` has a board whose `workflow` is `ship-feature` and whose cards use those four run ids.
- **Open the finished card.** `click` the uid of the link `#128 Add a dark mode toggle to the settings page`. `wait_for` text `ship-feature`. `take_snapshot` to `<evidence>/board/opened.a11y.txt` and `take_screenshot` `filePath` `<evidence>/board/opened.png`. The URL path is `/runs/<runs.finished>`.
- **Brand entry.** On `#/board` (the app shell, not the Run view), `click` the link named `Cursor Workflows`. The Board stays: the heading is `Board` and the document title is `Board · Cursor Workflows`. The Run view is a separate page and has no brand link; its way back is the breadcrumb `Runs`.

## Gotchas

- Empty phase columns stay in the accessibility tree as `Triage: 0` and the other phase names with `: 0`. They are folded strips, not missing columns.
- The Backlog column appears only when a forge returns an issue or an error. The fixture remote is a local git directory. A Backlog alert is not a failed board. Do not require a Backlog card.
- Cards poll `/api/board` every 2 seconds. The Backlog polls `/api/backlog` every 5 seconds and must not block the cards.
- The card title is the issue title, not the run id. The run id proof is the URL after the click plus `/api/board`.
