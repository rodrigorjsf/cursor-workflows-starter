---
name: cursor-workflows-setup
description: "Use to set up, check, upgrade, validate or tune the Cursor Workflows kit in a repo: wf init, the delivery defaults (worktree or main tree, PR or not), wf doctor, wf upgrade, the Cursor IDE validation, wf config set and show, and the config files."
---

# Set up the kit

The kit is installed once per machine at `~/.cursor-workflows/kit`, with a `wf` command on the PATH and the kit's skills
linked into `~/.claude/skills/` (Cursor reads that folder too). Each repo gets its own files from `wf init`. Every
command below runs as `wf <command>` from the repo's root, or with `--cwd <repo>`.

If `wf` is not found, the installer's folder is probably off the PATH: run `~/.local/bin/wf` instead, and tell the user
to add `~/.local/bin` to their PATH. If that file or `~/.cursor-workflows/kit` is missing, the kit is not installed: the
user installs it with the install guide, `INSTALL-AGENT.md`, in the kit's GitHub repository.

The runtime's messages are in English. This skill quotes the ones it matches, in code spans.

Pick the task, then run its steps in order. Each step ends on a stated result.

## Init a repo

1. Run `wf init`. It writes `.cursor/mcp.json` and `.mcp.json` (the `workflows` server, through `${userHome}` and
   `${HOME}`, so the files are the same for the whole team), `.cursor/sandbox.json` (`readBoundary: "workspace"`, other
   keys kept), `.agents/workflows/config.json` (schema address and the
   `kit` version range), the `.workflows/` line in `.gitignore`, and a marked block in `AGENTS.md`. Done when it exits 0.
   - The user can decline the `AGENTS.md` block with `wf init --no-agents-md`, and undo it later with `wf init --remove`.
   - Running it again changes nothing.
2. Show the user the diff that `wf init` printed on stdout, and its summary from stderr. `wf init` never runs git:
   the user reviews the diff and commits. Done when the user has seen every changed file.
   - A stderr line that starts with `wf init: Claude Code reads` means a Claude Code memory file (`CLAUDE.md`,
     `.claude/CLAUDE.md` or `CLAUDE.local.md`, in the repo root or any directory above it; `~/.claude/CLAUDE.md` does
     not count) hides `AGENTS.md`, and none of those files is `AGENTS.md` or imports it, so Claude Code does not see the
     kit block. Relay the line as printed: it names the import that works from the file to edit (`@AGENTS.md` in a root
     `CLAUDE.md` or `CLAUDE.local.md`, `@../AGENTS.md` in `.claude/CLAUDE.md`, or a new root `CLAUDE.md` holding
     `@AGENTS.md` when the file sits above the repo). The user decides; `wf init` does not write those files.
3. Follow "Choose the delivery defaults". Done when its last step passes.
4. Run the checks in "Check the setup". Done when `wf doctor` exits 0.
5. Tell the user to enable the `workflows` server in the IDE (Cursor: the MCP list in Customize; Claude Code: approve it
   when asked), then restart it. Done when the user has the instruction.

## Choose the delivery defaults

Run it after `wf init`, and again whenever the user wants runs to deliver differently. `implement-issue` has two delivery
settings, and the user picks the global default of each.

1. Ask the two questions one at a time with the host's question tool (`AskQuestion` in Cursor, `AskUserQuestion` in
   Claude Code; in a host with neither, ask in the chat) and wait for each answer. The user decides: you write what they
   said. Done when the user has answered both.
   - **Where do runs work?** The main tree: the run's branch is checked out in the folder the user has open, so the IDE
     shows the files change while the run works; the tree must be clean when a run starts, it belongs to the run until
     the run ends, and one such run goes at a time per repo. This is the code default. Or a worktree: each run works in
     a folder of its own under `.workflows/worktrees/`, so the user's tree stays untouched and runs go in parallel; the
     IDE shows nothing of it until the user opens that folder.
   - **Do runs open a PR?** Yes: the run pushes its branch, opens the PR (the MR on GitLab) and returns the link. This
     is the code default. Or no: the run leaves the branch committed locally, with no push and no PR, for the user to
     review first.
2. Write each answer to the global config, `~/.cursor-workflows/config.json`, even when it matches the code default.
   Done when both commands of the answers exited 0:

   | Answer | Command |
   |---|---|
   | main tree | `wf config set workflows.implement-issue.settings.worktree false` |
   | worktree | `wf config set workflows.implement-issue.settings.worktree true` |
   | PR | `wf config set workflows.implement-issue.settings.openPr true` |
   | no PR | `wf config set workflows.implement-issue.settings.openPr false` |

3. Show the user how one repo differs from those defaults, from that repo's root. Done when the user has seen both
   commands:

   ```bash
   wf config set --repo workflows.implement-issue.settings.worktree true
   wf config set --repo workflows.implement-issue.settings.openPr false
   ```

   These write `.agents/workflows/config.json`, the file the repo commits, and a repo value beats the global one. A
   single run beats both: `wf start` takes `--worktree` and `--no-pr`.
4. Run `wf config show implement-issue`. Done when `provenance` names the layer `global` for `/settings/worktree` and
   `/settings/openPr`, or `repo` for one that the repo's own file already sets.

## Check the setup

1. Run `wf doctor --json`. Its `checks`, always in this order: `node`, `dependencies`, `endpoints`, `login`, `models`,
   `forge`, `mcp-server`, `config`, `kit-version`, `sandbox`, `kit`, `state`, `host`. `ok: true` and exit code 0 mean the setup works. A check's `status` is
   `pass`, `warn` or `fail`: a `warn` passed, and names something worth fixing. Done when no check is `fail`, or each failing
   check's `message` and `hint` went to the user, and each `warn`'s `message` and `hint` went to the user too.
   - On a Node older than 22.13 the report holds the `node` check alone.
   - `node` and `mcp-server` depend on the environment the IDE starts: run `wf doctor` from a terminal the IDE opened.
2. Fix what a `hint` lets you fix. Hand the user what needs them:
   - `endpoints`: `CURSOR_BACKEND_URL` or `CURSOR_WEBSITE_URL` holds something other than an https URL on `cursor.sh` or
     `cursor.com`, and the SDK would send the user's API key to it. Tell the user which variable and where it is set (the
     message names the file when it is an MCP entry's `env`); unsetting it is their call. `login` and `models` do not run until
     it passes.
   - `login`: `wf login` opens a browser, so the user runs it; `NO_OPEN_BROWSER=1 wf login` prints the URL on stderr for
     a machine with no browser. The Cursor API key is the user's secret: keep it out of every command, log and reply.
     A passing `login` ends with a reminder that Privacy Mode cannot be read through the SDK: if the user has not said
     yet that it is on (Cursor Settings → General, or enforced by their team admin), ask, and do not guess the answer.
   - `forge`: `gh` (GitHub) or `glab` (GitLab) is missing or logged out: the user runs `gh auth login` or
     `glab auth login --hostname <host>`. A host the kit does not know fails with a message that names the `forges` key:
     declaring it is the user's call (see "Read or change the config").
   - `forge` with `status: "warn"`: the GitHub login's token holds scopes the kit does not need (`admin:public_key`,
     `workflow`, `delete_repo`, ...). The `message` names them and the `hint` says how to remove them. Narrowing the token
     is the user's call: `gh auth refresh --remove-scopes <scopes>` opens a browser, and a fine-grained token goes in
     `GH_TOKEN`. The doctor never prints the token: keep it out of every command, log and reply. It does not read the scopes of
     a `glab` token.
   - `sandbox`: the global caps require the SDK sandbox (the installer writes `caps.requireSandbox: true`) and, on Linux,
     `bwrap` is not on the PATH: install bubblewrap (`sudo apt install bubblewrap`). The message also says whether a
     `sandbox.json` limits reads to the workspace (`readBoundary: "workspace"`); without it a step can read the
     Cursor key. Adding that setting, or turning the sandbox off, is the user's call.
   - `kit`: the kit installed at `~/.cursor-workflows/kit` has local changes (the message lists them) or is not on
     exactly the tag of its version. A step that ran without the sandbox, or the user, edited it, and an edit survives
     `wf upgrade`. Show the user the list. Only with their ok, reinstall: `mv ~/.cursor-workflows/kit
     ~/.cursor-workflows/kit.changed`, then run the installer again (INSTALL-AGENT.md, step 2). A development
     install (a link to a working copy) is reported, not checked.
   - `host` with `status: "warn"`: the `message` says either that the host is WSL with interop on, so a Windows process reads
     `~/.cursor/sdk/auth.json` through `\\wsl$` whatever its `0600` mode says and a step that runs without the sandbox can start
     Windows programs, or that the interop file could not be read, so the doctor cannot tell. Relay the `message` and `hint`: a separate WSL distribution, or `[interop]` with `enabled=false` in the `/etc/wsl.conf`
     of the distribution that runs untrusted repositories (it applies after the user stops that distribution from Windows).
     Editing `wsl.conf` and restarting WSL are the user's call. It is the check for a WSL host only: elsewhere it passes.
   - `models`: a model id in the config is not in the account's catalog; `wf models` lists the ids. Changing the
     config is the user's call (see "Read or change the config").
3. Run `wf doctor` again. Done when it exits 0, or when the user has the remaining failures and their hints. A `warn` does not
   change the exit code: relay it, do not loop on it.

## Upgrade the kit

1. Run `wf upgrade`. It moves the installed kit to the newest release tag and redoes its dependencies, the `wf`
   command and the skill links; stdout is `{ upgraded, from, to, tag }`. Done when it exits 0.
   - `upgraded: false` means the kit is already on the newest release.
   - A failure that says `moved upstream`, `is not immutable`, `has no release for tag` or `could not read the release
     of` is the tag check, which runs before the checkout: the kit stays on its old tag. Tell the user with the output.
     Retry once only for `could not read the release of`. Never add `--allow-mutable-tag` yourself: it skips the release
     check, and only the user may choose that, for a kit installed from a fork.
   - A refusal that names a dev install means the kit location links to a working copy: the user updates that copy with
     git, then you run `bash ~/.cursor-workflows/kit/scripts/install.sh --refresh`.
   - A refusal that says `the kit at <kit> has local changes: <list>; reinstall it` means the installed kit was edited:
     the kit stays where it was. Show the user the list; with their ok, reinstall as the `kit` check above says.
   - A failure after the checkout leaves the kit on the new tag: fix the error shown, then run the same
     `install.sh --refresh`.
2. In each repo the user names, run `wf init`, then `wf doctor`. `wf init` rewrites the repo's MCP server entry in the
   form the new kit writes; show the user its diff, as in "Init a repo". The doctor's `kit-version` check compares the
   kit with the `kit` range in `.agents/workflows/config.json`. Done when every named repo passes, or the user has the
   failures.
   - A kit newer than the range is the user's decision: they widen `kit` in the repo config once they have checked
     the repo with the new kit.

## Validate the kit in the Cursor IDE

Follow [references/validate.md](references/validate.md): the kit's validation wizard for the user to run, or the seven
scenarios by hand. Done when the user has the wizard's command, or each scenario is recorded as pass or fail with a
note.

## Read or change the config

Follow [references/config.md](references/config.md): the two config files, the caps, the roles and how to read
`wf config show`. Done when `wf config show <workflow>` reports the values the user asked for and no violations, or
the user has been told each violation.

## Boundaries

- The global caps in `~/.cursor-workflows/config.json` belong to the user. Raise, loosen or remove one only when the user
  asks for that exact change.
- Starting a workflow is the `run-workflow` skill's job; this skill stops once the setup works.
