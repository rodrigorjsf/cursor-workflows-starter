<!-- cursor-workflows:begin -->
- Never print or log the Cursor API key (`~/.cursor/sdk/auth.json`, `CURSOR_API_KEY`). Never start a workflow from inside a workflow step: the runtime blocks the accidental path, not a deliberate one.
- Run workflows from the chat with `/run-workflow`: start the job, follow it, report the result. Do not redo steps or edit files while it runs.
- Commits, pushes and pull requests belong to the workflow code, not to you.
- To set up, upgrade or troubleshoot the Cursor Workflows kit, follow https://github.com/rodrigorjsf/cursor-workflows-starter/blob/v0.3.0/INSTALL-AGENT.md
<!-- cursor-workflows:end -->
