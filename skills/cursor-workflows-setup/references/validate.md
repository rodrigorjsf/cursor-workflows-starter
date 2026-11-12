# Validate the kit in the Cursor IDE

"The kit works in the Cursor IDE" means seven scenarios pass in the real IDE, on the machine of the person who will use
it. The IDE's behavior is the evidence: never mark a scenario pass on your own reading of the output.

## The guided way

The kit ships a wizard that sets the sandbox up, says what to type in the chat for each scenario, asks what the user
saw and writes the report. It asks questions, so the user runs it, in the IDE's own terminal (the Terminal panel):

```bash
~/.cursor-workflows/kit/scripts/verify/validate-cursor-ide.sh
```

- It creates a private sandbox repo with three `complexity:low` issues (through `setup-sandbox-repo.sh`), then runs
  `wf init` and `wf doctor` on it. Scenario 1 is read from `wf doctor`, and counts only when the user says the terminal is
  the IDE's.
- Each other scenario gets the exact text to type (or what to look at, in scenario 7), then a result (pass, fail or skip)
  and a one-line note.
- After scenario 7 it asks whether to run the optional scenario 8 (a step in the cloud); a "no" records nothing.
- Scenario 5 quits Cursor, which ends the wizard (it runs in Cursor's terminal). The answers are kept: the user reopens
  Cursor and runs the wizard again, and it goes on from scenario 5.
- It writes `validation-report.json` with local paths and repository names anonymized, shows the body of the issue, and
  files it on the kit's repository only after the user confirms.

Done when the user has the report and has said whether to file it. Hand them the command; keep the answers theirs.

## The scenarios by hand

Without the wizard, walk the user through the same seven, in order, and record each as pass or fail with a one-line
note. Use a throwaway repo for scenarios 3 to 7, never one the user cares about, and keep the run caps low (the chat
accepts tighter `overrides` per run).

1. **Doctor is green in the IDE's environment.** The user opens the IDE's own terminal in the repo and you run
   `wf doctor --json` there. Pass: exit 0. The IDE picks its `node` from its own PATH, so a terminal outside the IDE
   proves nothing.
2. **The MCP server is visible and enabled.** The user opens the MCP list in the IDE (Customize, in Cursor). Pass:
   the `workflows` server is on, with five tools: `list_workflows`, `start_workflow`, `wait_workflow`,
   `get_workflow_status`, `cancel_workflow`. The MCP log (Output, MCP Logs) shows why when it is not.
3. **A cheap workflow finishes from the chat.** The user types `/run-workflow smoke` in the chat. `smoke` is one agent
   step on `composer-2.5` with a 50k-token cap. Pass: the job ends `finished` and its result has `answer: "pong"`. A
   model outside the account's catalog fails the step: `wf models` lists the ids, and `workflows.smoke.roles.ping.model`
   in the config swaps it.
4. **`implement-issue` opens a pull request on a sandbox repo.** The user creates a private GitHub repo with one issue
   labelled `complexity:low`; the kit ships a script that does it, `~/.cursor-workflows/kit/scripts/verify/setup-sandbox-repo.sh
   <owner/new-repo>`. In the chat, with that repo open: `/run-workflow implement-issue 1` with `openPr: true` (the workflow opens no PR
   unless asked). Pass: the job ends `finished` and the PR exists on GitHub.
5. **A run survives restarting Cursor.** Start a run (scenario 4's issue, or any run that takes minutes), then the user
   quits and reopens Cursor. Pass: `wf jobs` still lists the job, and it finishes, or `get_workflow_status` reports
   `failed` with a `runId` and a resume (`start_workflow` with `resumeRunId`) completes it without repeating finished
   steps.
6. **A run cancels from the chat.** Start a run, then ask the chat to cancel it. Pass: the job ends `cancelled` and its
   `runId` can be resumed.
7. **The dashboard shows the run live.** The user types `/run-workflow smoke` in the chat. The chat gives the dashboard
   link (`dashboardUrl`, `http://127.0.0.1:4317` unless `WF_DASH_PORT` says otherwise) and opens it in Cursor's built-in
   browser. Pass, all in that browser: the run's card is in the Ping column of the smoke board and moves to Done on its
   own, without reloading; clicking the card opens the Run view, whose graph draws the `ping` step (it pulses while it
   runs, then turns green); hovering the step shows its model, location, attempts, tokens, cost and duration; clicking it
   opens its log (prompt, what the agent said, tool calls). A page that is blank, or a link that is refused, is a fail:
   note what the browser showed.

8. **Optional: a read-only step runs on a Cursor cloud agent.** It sends the sandbox repo's code to a VM, so it needs a
   Cursor plan with Cloud Agents and the sandbox repo on a GitHub account Cursor is connected to, and only the user can
   allow it: they merge `{ "caps": { "allowedLocations": ["local", "cloud"] }, "workflows": { "smoke": { "roles": { "ping":
   { "location": "cloud" } } } } }` into `~/.cursor-workflows/config.json` (and take it out afterwards). The user types
   `/run-workflow smoke`. Pass: the job ends `finished` with `answer: "pong"`, the run's log has a `cloud-agent` event with a
   `bc-` agent id, and `git ls-remote --heads origin 'wf/cloud-snapshot/*'` in the sandbox lists nothing. The wizard asks
   whether to run it; the report lists it as optional, and the release criterion counts scenarios 1 to 7 only. In the
   dashboard's page of that run the `ping` step carries a cloud badge, and hovering it shows a link to the agent in Cursor
   and its cost; look, but the result does not depend on it.

When a scenario fails, collect the `wf doctor --json` output and the failing job's `wf status <jobId>`, replace local
paths and repo names with placeholders, show the user the text, and file a GitHub issue on the kit's repository only
after they confirm it.
