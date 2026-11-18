# Run view

The Run view draws one run as a graph. A person opens a step's log, and replays a run that has finished.

## Sub-features

- `run-open` shows the finished run's graph, status, and stats.
- `run-log` opens the `review` step log.
- `run-replay` starts Replay and then stops it.

## How to get to it (user POV)

- Choose the run id in the Runs table.
- Choose the card title on the Board.
- Open `/runs/<runId>`.

## Driving it with chrome-devtools and Playwright

Preconditions:

- Doctor exited 0.
- `runs.finished` is the run to open.
- The page to open is `<url>/runs/<runs.finished>`.

Playwright, when Chrome DevTools does not answer:

```bash
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py goto --path /runs/<runs.finished>
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text finished
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/run-view/graph.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role button --name-regex "review:.*Open its log"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text "Log of review"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/run-view/log.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role button --name "Close the log"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role button --name Replay
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py wait --text "Stop replay"
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py snapshot --path <evidence>/run-view/replay.a11y.txt
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py screenshot --path <evidence>/run-view/replay.png
uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role button --name "Stop replay"
```

`Replay` is the accessible name (`▶` is hidden). After Stop, `drive.py count --text Replay` is at least `1` and `drive.py count --text "replay position"` is `0`.

- **Direct entry.** `new_page` with that URL and `isolatedContext` from the record. `wait_for` text `ship-feature` and `finished`. `take_snapshot` to `<evidence>/run-view/graph.a11y.txt`. The heading contains `ship-feature` and the finished id. The breadcrumb link is `Runs`. The status text is `finished`. A button is named `Replay`. A button's name contains `review:` and `Open its log`.
- **Second view.** `GET <url>/api/runs/<runs.finished>` saved to `<evidence>/run-view/api-run.json` has `"status": "finished"` and the same run id.
- **Open the review log.** `click` the uid of the button whose name contains `review:` and `Open its log`. `wait_for` text `Log of review`. `take_snapshot` to `<evidence>/run-view/log.a11y.txt`. A complementary region (or the dialog name in the snapshot) is `Log of review`. A button is named `Close the log`.
- **Replay.** `click` `Close the log`. `click` the button named `Replay`. `wait_for` text `Stop replay`. `take_snapshot` to `<evidence>/run-view/replay.a11y.txt` and `take_screenshot` `filePath` `<evidence>/run-view/replay.png`. The snapshot has a slider named `replay position`, a listbox named `replay speed`, and a button named `Stop replay`.
- **Stop.** `click` `Stop replay`. Snapshot again. The button `Replay` is back. The slider `replay position` is gone.

## Gotchas

- `Replay` is offered only when the run is not `running` and the log has events. The finished fixture qualifies. A running live job (`up` does not pass `--live`) has no Replay button.
- The `review` button name includes the node state (`review: ok. Open its log`, and `, cloud agent` when the step is marked cloud). Match `review:` plus `Open its log`. Do not require the cloud words unless the snapshot shows them.
- React Flow's Fit control is named `Fit View (follow the run again)`. Panning the canvas stops the follow; that control hands it back. A proof that pans has to fit again before asserting which node is in view.
- The graph settles after layout. `wait_for` the `review:` button. Do not click a uid from the first snapshot if a later snapshot replaced it.
- Replay hides the run actions (Resume, Copy resume command) until Stop.
