# Validate the kit in the Cursor IDE

"The kit works in the Cursor IDE" means six scenarios pass in the real IDE, on the machine of the person who will use
it. Walk the user through them in order, ask what they saw, and record each as pass or fail with a one-line note.
Never mark a scenario pass on your own reading of the output: the IDE's behavior is the evidence.

Use a throwaway repo for scenarios 3 to 6, never one the user cares about, and keep the run caps low (the chat accepts
tighter `overrides` per run).

1. **Doctor is green in the IDE's environment.** The user opens the IDE's own terminal in the repo and you run
   `wf doctor --json` there. Pass: exit 0. The IDE picks its `node` from its own PATH, so a terminal outside the IDE
   proves nothing.
2. **The MCP server is visible and enabled.** The user opens the MCP list in the IDE (Customize, in Cursor). Pass:
   the `workflows` server is on, with five tools: `list_workflows`, `start_workflow`, `wait_workflow`,
   `get_workflow_status`, `cancel_workflow`. The MCP log (Output, MCP Logs) shows why when it is not.
3. **A cheap workflow finishes from the chat.** Run `wf list`. When it shows `smoke`, the user types
   `/run-workflow smoke` in the chat. Pass: the job ends `finished` with a structured result. Without a `smoke`
   workflow, record the scenario as not run.
4. **`implement-issue` opens a pull request on a sandbox repo.** The user creates a private GitHub repo with one issue
   labelled `complexity:low`; the kit ships a script that does it, `~/.cursor-workflows/kit/scripts/verify/setup-sandbox-repo.sh
   <owner/new-repo>`. In the chat, with that repo open: `/run-workflow implement-issue 1`. Pass: the job ends
   `finished` and the PR exists on GitHub.
5. **A run survives restarting Cursor.** Start a run (scenario 4's issue, or any run that takes minutes), then the user
   quits and reopens Cursor. Pass: `wf jobs` still lists the job, and it finishes, or `get_workflow_status` reports
   `failed` with a `runId` and a resume (`start_workflow` with `resumeRunId`) completes it without repeating finished
   steps.
6. **A run cancels from the chat.** Start a run, then ask the chat to cancel it. Pass: the job ends `cancelled` and its
   `runId` can be resumed.

When a scenario fails, collect the `wf doctor --json` output and the failing job's `wf status <jobId>`, replace local
paths and repo names with placeholders, show the user the text, and file a GitHub issue on the kit's repository only
after they confirm it.
