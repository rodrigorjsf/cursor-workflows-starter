# Install Cursor Workflows (guide for coding agents)

You are a coding agent installing the Cursor Workflows kit for your user, then setting up the repo you are in. This
guide is pinned to release `v0.3.0` and needs no other document. Run the steps in order. Each step ends on a stated
result: when you cannot reach it, stop and tell the user what failed, with the command output.

The kit runs deterministic workflows on the Cursor SDK from the Cursor IDE chat (MCP), Claude Code or a terminal. The
kit's messages are in English; this guide quotes the few it matches as they are printed. Supported: Linux and WSL2.

Ground rules:

- The Cursor API key is the user's secret: keep it out of every command, file, log and reply.
- Do not commit anything. The user reviews and commits what `wf init` writes.
- A workflow never starts another workflow from inside a step.

## 1. Check the machine

Run `git --version`, `npm --version` and `node --version`. Done when all three answer and Node is 22.13 or newer.

An older Node stops the kit (the Cursor SDK needs 22.13). Tell the user to install a newer one and make it the default
on the PATH their IDE starts with: a version manager activated only in the shell's profile is often not active there.
Stop until they have.

## 2. Install the kit, once per machine

```bash
curl -fsSL https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/v0.3.0/scripts/install.sh -o /tmp/wf-install.sh
bash /tmp/wf-install.sh --tag v0.3.0
```

The installer:

- clones the kit at tag `v0.3.0` into `~/.cursor-workflows/kit` and installs its dependencies;
- writes the `wf` command to `~/.local/bin/wf`;
- links the kit's skills (`run-workflow`, `cursor-workflow-authoring`, `skill-to-workflow`, `cursor-workflows-setup`)
  into `~/.claude/skills/`, which Cursor and Claude Code both read;
- writes `~/.cursor-workflows/config.json` with the default hard caps (3,000,000 tokens and 500 cents per run, 600,000
  tokens per step, concurrency 4, local steps only) when the file does not exist yet.

Running it again is safe. Done when it exits 0 after printing `kit ready at <kit>`, and `wf list` prints a JSON list
that includes `implement-issue`.

- A line starting `warning:` is a warning, not a failure. Relay it. One of them says `~/.local/bin` is not on the PATH
  (`... is not on the PATH, so the wf command will not be found.`):
  for this session run `export PATH="$HOME/.local/bin:$PATH"`, and tell the user to add that folder to their shell's
  profile (bash or zsh: `~/.profile`; fish: `fish_add_path ~/.local/bin`) and to restart the IDE afterwards.
- A line starting `error:` is a failure: fix what it names and run the installer again. For example,
  `<tool> is not on the PATH; install it and run again` or `Node <have> (<path>) is too old: the kit needs <need> or
  newer. Install a newer Node, put it on the PATH and run again`.

## 3. Log in to the Cursor SDK

Run `wf whoami`. Done when it prints an `apiKeyName`.

When it does not, the user logs in: ask them to run `wf login` in their own terminal (it opens a browser and saves a key
in `~/.cursor/sdk/auth.json`), or to export `CURSOR_API_KEY`. On a machine with no browser, run
`NO_OPEN_BROWSER=1 wf login` in the background and give the user the URL it prints on stderr right away: it expires
within minutes. A plan without SDK access fails here with `plan_required`; relay that to the user as it is.

## 4. Set up the repo

From the root of the repo the user wants to use the kit in:

```bash
wf init
```

It writes `.cursor/mcp.json` and `.mcp.json` (the `workflows` MCP server, with no absolute paths, so the same file works
for the whole team), `.agents/workflows/config.json` (editor autocomplete and the kit version range), the `.workflows/`
line in `.gitignore`, and a short marked block of safety rules in `AGENTS.md`. Running it again changes nothing.

Done when it exits 0, you have shown the user the diff it printed on stdout, and you have relayed, as printed, any stderr
line that starts with `wf init: Claude Code reads`. That line means a Claude Code memory file (such as `CLAUDE.md`) hides
`AGENTS.md`, so Claude Code does not see the kit's safety rules; it names the import line to add. The user decides:
`wf init` does not write Claude Code's memory files. It never runs git: the user reviews the diff and commits. The user can decline the `AGENTS.md` block with `wf init --no-agents-md` and undo it later with
`wf init --remove`.

## 5. Run the doctor

```bash
wf doctor --json
```

Done when it exits 0 (`"ok": true`). Otherwise each failing entry in `checks` has a `message` and a `hint`: do what the
hint says if you can, hand the user what needs them (the login, a newer Node, `gh auth login` or `glab auth login`), and
run the doctor again. The checks, in this order: `node`, `dependencies`, `login`, `models`, `forge`, `mcp-server`,
`config`, `kit-version`. `forge` asks the CLI of the repository's forge (`gh` for GitHub, `glab` for GitLab) and passes
outside a git repository.

Run the doctor from a terminal the IDE opened when you can: `node` and `mcp-server` follow the environment the IDE
starts.

## 6. Hand over

Tell the user:

1. which files `wf init` wrote, and that committing them is their call;
2. to enable the `workflows` server in their IDE (Cursor: the MCP list under Customize; Claude Code: approve it when it
   asks) and to restart the IDE;
3. that `/run-workflow <name> <args>` in the chat starts a workflow, for example `/run-workflow implement-issue 123`,
   and that the hard caps they can tune live in `~/.cursor-workflows/config.json`.

From here on the `cursor-workflows-setup` skill (now installed) covers init, doctor, upgrade, validation and config.

## Later

- **Upgrade:** `wf upgrade` moves the kit to the newest release and keeps the skill links valid.
- **Develop the kit itself:** in a clone, `scripts/install.sh --dev` points `~/.cursor-workflows/kit` at that clone
  instead of a tag. `wf upgrade` refuses such an install.
