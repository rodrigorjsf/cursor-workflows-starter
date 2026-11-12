---
name: cursor-workflows-setup
description: "Use to set up, check, upgrade, validate or tune the Cursor Workflows kit in a repo: wf init, wf doctor, wf upgrade, the Cursor IDE validation, wf config show and the config files."
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
   `${HOME}`, so the files are the same for the whole team), `.agents/workflows/config.json` (schema address and the
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
3. Run the checks in "Check the setup". Done when `wf doctor` exits 0.
4. Tell the user to enable the `workflows` server in the IDE (Cursor: the MCP list in Customize; Claude Code: approve it
   when asked), then restart it. Done when the user has the instruction.

## Check the setup

1. Run `wf doctor --json`. Its `checks`, always in this order: `node`, `dependencies`, `login`, `models`, `gh`,
   `mcp-server`, `config`, `kit-version`. `ok: true` and exit code 0 mean the setup works. Done when every check is
   `pass`, or each failing check's `message` and `hint` went to the user.
   - On a Node older than 22.13 the report holds the `node` check alone.
   - `node` and `mcp-server` depend on the environment the IDE starts: run `wf doctor` from a terminal the IDE opened.
2. Fix what a `hint` lets you fix. Hand the user what needs them:
   - `login`: `wf login` opens a browser, so the user runs it; `NO_OPEN_BROWSER=1 wf login` prints the URL on stderr for
     a machine with no browser. The Cursor API key is the user's secret: keep it out of every command, log and reply.
   - `gh`: `gh auth login`, by the user.
   - `models`: a model id in the config is not in the account's catalog; `wf models` lists the ids. Changing the
     config is the user's call (see "Read or change the config").
3. Run `wf doctor` again. Done when it exits 0, or when the user has the remaining failures and their hints.

## Upgrade the kit

1. Run `wf upgrade`. It moves the installed kit to the newest release tag and redoes its dependencies, the `wf`
   command and the skill links; stdout is `{ upgraded, from, to, tag }`. Done when it exits 0.
   - `upgraded: false` means the kit is already on the newest release.
   - A refusal that names a dev install means the kit location links to a working copy: the user updates that copy with
     git, then you run `bash ~/.cursor-workflows/kit/scripts/install.sh --refresh`.
   - A failure after the checkout leaves the kit on the new tag: fix the error shown, then run the same
     `install.sh --refresh`.
2. Run `wf doctor` in each repo the user names. Its `kit-version` check compares the kit with the `kit` range in
   `.agents/workflows/config.json`. Done when every named repo passes, or the user has the failures.
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
