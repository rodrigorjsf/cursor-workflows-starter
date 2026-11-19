# Install Cursor Workflows (guide for coding agents)

You are a coding agent installing the Cursor Workflows kit for your user, then setting up the repo you are in. This
guide is pinned to release `v0.4.0` and needs no other document. Run the steps in order. Each step ends on a stated
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
installer="$(mktemp)"
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/rodrigorjsf/cursor-workflows-starter/v0.4.0/scripts/install.sh -o "$installer"
bash "$installer" --tag v0.4.0
```

The installer:

- checks the tag before it clones or checks out anything: it reads the GitHub release of `v0.4.0` and stops unless the
  release is immutable (GitHub locks an immutable release's tag to its commit, so nobody can move the tag to other
  code), and, when a clone of the kit already exists, it fetches the tags without `--force`, so a tag that moved since
  the last fetch stops the install;
- clones the kit at tag `v0.4.0` into `~/.cursor-workflows/kit` and installs its dependencies;
- writes the `wf` command to `~/.local/bin/wf`;
- links the kit's skills (`run-workflow`, `cursor-workflow-authoring`, `skill-to-workflow`, `cursor-workflows-setup`)
  into `~/.claude/skills/`, which Cursor and Claude Code both read;
- writes `~/.cursor-workflows/config.json` with the default hard caps (3,000,000 tokens and 500 cents per run, 600,000
  tokens per step, concurrency 4, local steps only, and `requireSandbox: true`, which runs every step in the Cursor SDK
  sandbox: no network except the hosts of a `.cursor/sandbox.json`, and no writes outside the repository) when the
  file does not exist yet. On Linux the sandbox needs `bubblewrap` (`bwrap` on the PATH) unless the kernel offers
  Landlock; `wf doctor` fails, naming bubblewrap, when it is missing.

Running it again is safe. Done when it exits 0 after printing `kit ready at <kit>`, and `wf list` prints a JSON list
that includes `implement-issue`.

- A line starting `warning:` is a warning, not a failure. Relay it. One of them says `~/.local/bin` is not on the PATH
  (`... is not on the PATH, so the wf command will not be found.`):
  for this session run `export PATH="$HOME/.local/bin:$PATH"`, and tell the user to add that folder to their shell's
  profile (bash or zsh: `~/.profile`; fish: `fish_add_path ~/.local/bin`) and to restart the IDE afterwards.
- A line starting `error:` is a failure: fix what it names and run the installer again. For example,
  `<tool> is not on the PATH; install it and run again` or `Node <have> (<path>) is too old: the kit needs <need> or
  newer. Install a newer Node, put it on the PATH and run again`.
- `error: the kit at <kit> has local changes: <list>; reinstall it` means an earlier install was edited (by the user, or
  by a step that ran without the sandbox), and the installer will not move it or run `npm ci` in it. Show the user the
  list. Only with their ok, move the folder aside (`mv ~/.cursor-workflows/kit ~/.cursor-workflows/kit.changed`, so they
  can read what changed) and run the installer again; the global config and the skill links stay.
- An `error:` line about the tag means the install is unsafe or not possible: it contains `moved upstream` (a release
  tag was re-pointed), `is not immutable`, `has no release for tag` or `could not read the release of`. Stop and tell
  the user, with the command output. Retry once only for `could not read the release of`, which is usually the
  network. Never add `--allow-mutable-tag` yourself: it skips the release check, and only the user may choose that,
  for a fork they install with `--repo`.

## 3. Log in to the Cursor SDK

Run `wf whoami`. Done when it prints an `apiKeyName`.

When it does not, the user logs in: ask them to run `wf login` in their own terminal (it opens a browser and saves a key
in `~/.cursor/sdk/auth.json`), or to export `CURSOR_API_KEY`. On a machine with no browser, run
`NO_OPEN_BROWSER=1 wf login` in the background and give the user the URL it prints on stderr right away: it expires
within minutes. A plan without SDK access fails here with `plan_required`; relay that to the user as it is.

## 4. Confirm Privacy Mode

With Privacy Mode off, Cursor may store the code, prompts and command output that every step of a workflow sends, and
train on them (<https://cursor.com/data-use>). SDK runs follow the same Privacy Mode rules as the IDE. The SDK does not
say whether the mode is on, so you cannot check it: ask the user.

Ask the user to confirm that Privacy Mode is on: under Cursor Settings → General for an individual account, or enforced
by their team admin for a team account. Do not go on until they answer. Never guess the answer, and never change the
setting for them.

Done when the user has answered. A user who says it is off, or that they do not know, finds the setting (or asks their
team admin) and tells you what it says. Going on with it off is the user's call, not yours.

## 5. Set up the repo

From the root of the repo the user wants to use the kit in:

```bash
wf init
```

It writes `.cursor/mcp.json` and `.mcp.json` (the `workflows` MCP server, with no absolute paths, so the same file works
for the whole team), `.cursor/sandbox.json` (`readBoundary: "workspace"`, so a sandboxed step reads nothing outside the
repository; its other keys stay), `.agents/workflows/config.json` (editor autocomplete and the kit version range), the `.workflows/`
line in `.gitignore`, and a short marked block of safety rules in `AGENTS.md`. Running it again changes nothing.

Done when it exits 0, you have shown the user the diff it printed on stdout, and you have relayed, as printed, any stderr
line that starts with `wf init: Claude Code reads`. That line means a Claude Code memory file (such as `CLAUDE.md`) hides
`AGENTS.md`, so Claude Code does not see the kit's safety rules; it names the import line to add. The user decides:
`wf init` does not write Claude Code's memory files. It never runs git: the user reviews the diff and commits. The user can decline the `AGENTS.md` block with `wf init --no-agents-md` and undo it later with
`wf init --remove`.

## 6. Choose the delivery defaults

`implement-issue` delivers its work in two ways that the user picks between, and each pick has a default for every repo
on this machine. Ask the two questions below one at a time with the host's question tool (`AskQuestion` in Cursor,
`AskUserQuestion` in Claude Code; in a host with neither, ask in the chat) and wait for each answer. The user decides:
you write what they said.

1. **Where do runs work?**
   - The main tree: the run's branch is checked out in the folder the user has open, so the IDE shows the files change
     while the run works. The tree must be clean when a run starts, it belongs to the run until the run ends, and one
     such run goes at a time per repo. This is the code default.
   - A worktree: each run works in a folder of its own under `.workflows/worktrees/`, so the user's tree stays untouched
     and runs go in parallel. The IDE shows nothing of it until the user opens that folder.
2. **Do runs open a PR?**
   - Yes: the run pushes its branch, opens the PR (the MR on GitLab) and returns the link. This is the code default.
   - No: the run leaves the branch committed locally, with no push and no PR, for the user to review first.

Write both answers to the global config, `~/.cursor-workflows/config.json`, with the command of each answer, even when it
matches the code default:

| Answer | Command |
|---|---|
| main tree | `wf config set workflows.implement-issue.settings.worktree false` |
| worktree | `wf config set workflows.implement-issue.settings.worktree true` |
| PR | `wf config set workflows.implement-issue.settings.openPr true` |
| no PR | `wf config set workflows.implement-issue.settings.openPr false` |

Then show the user how one repo differs from those defaults. From that repo's root:

```bash
wf config set --repo workflows.implement-issue.settings.worktree true
wf config set --repo workflows.implement-issue.settings.openPr false
```

These write `.agents/workflows/config.json`, the file the repo commits, and a repo value beats the global one. A single
run beats both: `wf start` takes `--worktree` and `--no-pr`. `wf config show implement-issue` names the layer each
value came from.

Done when both answers are in the global config (`wf config show implement-issue` prints `"layer": "global"` for
`/settings/worktree` and `/settings/openPr` under `provenance`, or `"layer": "repo"` for one that the repo's own file
already sets) and the user has seen the two `--repo` commands.

## 7. Run the doctor

```bash
wf doctor --json
```

Done when it exits 0 (`"ok": true`). Otherwise each failing entry in `checks` has a `message` and a `hint`: do what the
hint says if you can, hand the user what needs them (the login, a newer Node, `gh auth login --hostname <host>` or
`glab auth login --hostname <host>`), and run the doctor again. An entry with `"status": "warn"` does not fail the doctor: it
passed, and its `message` and `hint` name something to fix, such as a GitHub token that holds scopes the kit does not need.
Relay each warning to the user, and do not print the token. The message of a passing `login` check ends with a reminder that starts `Privacy Mode cannot be read through the SDK`: the doctor cannot read the mode, and step 4 already asked the user, so nothing more is due for it. The checks, in this order: `node`, `dependencies`, `endpoints`, `login`, `models`, `forge`, `mcp-server`,
`config`, `kit-version`, `sandbox`, `kit`, `state`, `host`. `endpoints` fails when `CURSOR_BACKEND_URL` or `CURSOR_WEBSITE_URL` is set to anything but an https URL on `cursor.sh` or `cursor.com`: the SDK would send the user's API key there, so `login` and `models` do not run until it passes. Do not fix it by editing the value: tell the user which variable it is and where it is set (the message names the file when it is an MCP entry's `env`), and let them unset it. `kit` fails when the installed kit has local changes or is not on exactly the tag of its version: reinstall it as step 2 says. `state` warns when the repository's `.workflows/` folder (the run state: event logs, journals, memo) can be entered by other users of the machine: it gives the `chmod 700` that closes it. `host` warns on a WSL host with interop on (a Windows process reads `~/.cursor/sdk/auth.json` through `\\wsl$`, whatever its `0600` mode says), and when it cannot read the interop file: relay its `hint` to the user, who decides about a separate WSL distribution or `[interop] enabled=false` in `/etc/wsl.conf`. `forge` asks the CLI of the repository's forge (`gh` for GitHub, `glab` for GitLab) and passes
outside a git repository. The host of `origin` picks the forge: `github.com` and `gitlab.com` are known, and any other
host (a self-managed GitLab) must be declared under the `forges` config key: until it is, the check fails with a message
that names the key. Declaring the host is the user's call.

Run the doctor from a terminal the IDE opened when you can: `node` and `mcp-server` follow the environment the IDE
starts.

## 8. Hand over

Tell the user:

1. which files `wf init` wrote, and that committing them is their call;
2. to enable the `workflows` server in their IDE (Cursor: the MCP list under Customize; Claude Code: approve it when it
   asks) and to restart the IDE;
3. that `/run-workflow <name> <args>` in the chat starts a workflow, for example `/run-workflow implement-issue 123`,
   and that the hard caps they can tune live in `~/.cursor-workflows/config.json`.

From here on the `cursor-workflows-setup` skill (now installed) covers init, doctor, upgrade, validation and config.

## Later

- **Upgrade:** `wf upgrade` moves the kit to the newest release and keeps the skill links valid. It makes the same tag
  checks as the installer and fails with the same message fragments (without the `error:` prefix); the same rule applies
  to `--allow-mutable-tag`.
- **Develop the kit itself:** in a clone, `scripts/install.sh --dev` points `~/.cursor-workflows/kit` at that clone
  instead of a tag. `wf upgrade` refuses such an install.
