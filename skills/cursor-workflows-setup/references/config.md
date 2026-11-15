# The config files

The kit reads two JSON files fresh at every run start, so an edit applies to the next run with no restart.

| File | Holds | Who edits it |
|---|---|---|
| `~/.cursor-workflows/config.json` (global) | `caps`: hard limits for every run on this machine, plus the user's own preferences | the user |
| `.agents/workflows/config.json` (repo, committed) | preferences per workflow and role, and `kit`, the accepted kit version range | the repo's team |

Both accept `$schema` (editor autocomplete and validation) and `$comment` anywhere. A key the schema does not know is an
error that names the file and the field path, such as `/workflows/implement-issue/roles/review/retries`.

The schema is the authoritative list of keys and their types:
`~/.cursor-workflows/kit/packages/runtime/schema/config.schema.json`, the file the config's `$schema` URL names. The
sections below name every key it accepts and what each one means. `wf config show <workflow>` prints the value each key
has now, defaults included.

## Caps

The installer writes these defaults to the global file when it has none:

| Cap | Default |
|---|---|
| `maxTokens` (per run) | 3,000,000 |
| `maxTokensPerStep` | 600,000 |
| `maxCents` (per run) | 500 |
| `allowedModels` | `null`: every model, models without zero data retention (ZDR) included. When retention matters, list only the models the account shows as ZDR |
| `allowedSettingSources` | `project`, `user`, `team`, `mdm`, `plugins` (never `all`) |
| `allowedLocations` | `local` |
| `maxConcurrency` | 4 |
| `maxRunningJobs` | 3 (key absent): `wf start`, `start_workflow` and the dashboard's Start refuse a job when that many already run in the repository, and refuse a job that runs the same workflow with the same args as one that runs. `null` lifts the first rule only |
| `requireSandbox` | `true`: the SDK's local sandbox runs every step (no network but the hosts of a `.cursor/sandbox.json`, no writes outside the repo; Linux needs bubblewrap). Absent: each step's own `sandbox` applies |

`null` switches a cap off. An absent key inherits from the layer below. Zero is zero.

The repo file and the chat can only **tighten** a cap: a number takes the smaller value, a list takes the
intersection. A request to loosen is recorded as a `violation` and has no effect. A `caps` block in the repo file is a
violation too.

## Preferences

Top-level keys besides `caps`:

- `kit` (repo file only): the semver range of kits the repo accepts.
- `cloud.remote` (either file): the git remote that cloud steps push their worktree snapshot branches to
  (`wf/cloud-snapshot/...`). Default `origin`; point it at a fork when `origin`'s CI must not run on every snapshot.
- `cloud.allowPublicRemote` (global file only): a snapshot that differs from HEAD holds uncommitted files, so before pushing it the
  kit scans it for secrets (always) and asks `gh repo view` whether the remote is public, and refuses a public remote or one `gh` cannot
  answer for (GitHub only: a GitLab remote is refused, since `glab` is not asked). `true` skips the question, never the scan. Default `false`; a repo file's value is a violation.
- `forges` (either file): which forge, `github` or `gitlab`, each host the kit does not know runs, as in
  `{ "git.example.com": "gitlab" }`. The kit knows `github.com` and `gitlab.com`; a repository whose `origin` (or `repo`
  argument, when it is a URL) is on any other host fails before any step until the host is declared here. A key is the
  host in lower case, with the port when the URL has one (`git.example.com:8443`); without a port it matches any port.
  The two files merge host by host, and the repo file wins on a host both name. No env var or flag sets it.
- `dashboard.autoStart` (global file only): `false` stops `start_workflow` from starting the dashboard.

Under `workflows.<name>`:

- `maxTokens`, `maxTokensPerStep`, `maxCents`, `concurrency`: limits for that workflow, held under the caps.
- `execTimeoutMs`: the time limit, in milliseconds, of a command the workflow runs with `ctx.exec` without its own
  `timeoutMs`; the command is killed when it runs out.
- `roles.<role>`: `model` (`id`, from the account's catalog; `params`, a list of `{ id, value }` such as
  `reasoning_effort`; `maxMode`; a field left out inherits from the layer below), `timeoutMs` (the step's time limit, in
  milliseconds), `retries` (extra attempts when the step ends in error), `schemaRetries` (follow-ups when the agent's
  answer does not match the step's JSON schema), `maxTokensPerStep`, `settingSources` (the configuration layers the step
  loads, intersected with the cap), and for cloud steps:
  - `location`: `local` (default) or `cloud`. `cloud` runs the role's steps on a Cursor cloud agent, against a snapshot
    of the worktree pushed to `cloud.remote`. It applies only when the global cap `allowedLocations` includes `cloud`
    (otherwise the step runs locally and the request is a violation), and a role the workflow marks `never` is refused.
  - `resultVia`: how a cloud step returns its structured result, `json-block` (default) or `artifact`.

  A workflow declares its roles; a role it does not declare is an error.
- `labels.<glob>`: the same preferences for steps that have no role, matched against the step's label with `*` and `?`;
  the glob with the most literal characters wins (`location` and `resultVia` apply to roles only).
- `settings`: the workflow's own settings, by the names it declares in `meta.settings`, set only in the two files; a
  name it does not declare is an error. A setting set in a higher layer replaces the lower one whole. `implement-issue`'s:
  - `sliceCaps` (per tier: `LOW`, `MED`, `HIGH`): the most TDD slices (red, then green) a run makes; the plan's slices
    past the cap are deferred, and the PR then references the issue without closing it.
  - `extraSlices`: the most new slices the review can add for a missing or wrong requirement.
  - `fixRounds`: fix rounds for a slice whose suite fails after green; past them the run ends `tests-failed`.
  - `redGreenAttempts`: attempts of each red and each green step; past them the run ends `tdd-violation` or
    `test-not-red`.
  - `maxDiffChars`: the longest diff, in characters, the review and PR prompts carry; the rest is cut.
  - `labelTiers`: issue label (case-insensitive) to tier; the highest matching tier wins, and with no match a cheap
    classifier decides. Setting it replaces the default map whole.
  - `maxStepCrashes`: how many times one write step may take the process down and be resumed; the next time the run
    ends `step-crash-loop`.
  - `testTimeoutSec`: the time limit, in seconds, of each test run and of the `setupCommand`; past it the command is
    killed. A suite past it ends the run `tests-timeout` (every suite, the one after the review's refactor
    included). A `setupCommand` past it ends the
    run `setup-failed`, as any failed setup does: before you read `setup-failed` as a broken setup command, check
    whether it ran this long.
  - `networkTimeoutSec`: the time limit, in seconds, of each network command (`git push`, `git ls-remote`, every `gh` or `glab`),
    for the workflow and `wf gc`.
  - `backlogLabel`: the label that marks an open issue as ready for `implement-issue` (default `ready-for-agent`; one
    label, no comma). The dashboard's Backlog column lists the open issues that carry it and have no run.
  - `repoHosts`: the hosts the `repo` argument may name besides the forge's own (`github.com` or `gitlab.com`), the host of
    `origin` and the hosts declared under `forges` (default none; `host` for any port, or `host:port`). The forge's CLI sends
    its token to the host it is given, so a `repo` such as `ghe.example.com/owner/name` ends the run before the first forge
    call unless the host is listed (on GitLab a path of four segments or more starts with a host: name a nested group by its
    URL). `wf gc` applies the same rule to the `repo` a run recorded.
  - `contextFiles`: the files and folders of the repository that the plan, design and PR-text agents are told to read for
    context: a glossary, the coding standards, the ADRs (one that does not exist is skipped). The default is the usual
    names (`GLOSSARY.md`, `CONTEXT.md`, `AGENTS.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md` and the ADR folder); `wf config
    show implement-issue` prints it. Set it when the repository keeps its glossary elsewhere. It replaces the default whole,
    so copy the printed list and change what differs. Paths are relative to the repository root: an absolute path, a `..`
    segment or a line break is refused when the config loads.
  - `gcFailedAfterDays`: `wf gc` removes a failed run's worktree and branches once it failed more days ago than this; a
    cancelled run never counts as failed. A run whose PR was merged or closed goes without waiting, and the origin
    branch stays while its PR is open.
  - `gcSnapshotGraceHours`: `wf gc` removes a cloud snapshot branch the step left behind once its run (of this repo)
    has no process and its last event is older than this many hours. The branch of a run cut off inside the step that
    owns it waits `gcFailedAfterDays` days instead, and the branch of a cancelled run stays.

`WF_MODEL_<ROLE>` environment variables (`WF_MODEL_REVIEW`, `WF_MODEL_IMPLEMENT_LOW`) set a role's model without a
file edit.

Precedence, lowest to highest: code defaults, global file, repo file, environment, command-line flags, the chat's
`overrides`. The caps clamp the result.

## Change a setting

`wf config show <workflow>` prints `files` (the two paths, each found or not) and, under `workflows.<workflow>`, `config`
(the values in force: `limits`, `caps`, `roles` and `settings`), `provenance` (the layer each value came from, by JSON
pointer into `config`) and `violations`.

1. Run `wf list`, then `wf config show <workflow>`. Done when you know the role name under `config.roles` and its
   current value.
2. Edit `.agents/workflows/config.json` (repo-wide, committed) or `~/.cursor-workflows/config.json` (this machine).
   Done when the file is valid JSON and uses only keys the schema knows.
3. Run `wf config show <workflow>` again. Done when `provenance` shows the layer you edited for the value you changed,
   and `violations` is empty or reported to the user.
4. A model id must exist in the account's catalog: `wf models` lists them, and `wf doctor` checks every id the config
   uses.
