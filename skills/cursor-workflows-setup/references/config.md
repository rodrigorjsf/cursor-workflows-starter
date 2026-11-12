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
| `allowedModels` | `null`: every model |
| `allowedSettingSources` | `project`, `user`, `team`, `mdm`, `plugins` (never `all`) |
| `allowedLocations` | `local` |
| `maxConcurrency` | 4 |
| `requireSandbox` | absent: each step's own `sandbox` applies; `true` forces the SDK's local sandbox on every step |

`null` switches a cap off. An absent key inherits from the layer below. Zero is zero.

The repo file and the chat can only **tighten** a cap: a number takes the smaller value, a list takes the
intersection. A request to loosen is recorded as a `violation` and has no effect. A `caps` block in the repo file is a
violation too.

## Preferences

Top-level keys besides `caps`:

- `kit` (repo file only): the semver range of kits the repo accepts.
- `cloud.remote` (either file): the git remote that cloud steps push their worktree snapshot branches to
  (`wf/cloud-snapshot/...`). Default `origin`; point it at a fork when `origin`'s CI must not run on every snapshot.
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
  - `testTimeoutSec`: the time limit, in seconds, of each test run (and the `setupCommand`); past it the run ends
    `tests-timeout`.
  - `networkTimeoutSec`: the time limit, in seconds, of each network command (`git push`, `git ls-remote`, every `gh`),
    for the workflow and `wf gc`.
  - `gcFailedAfterDays`: `wf gc` removes a failed run's worktree and branches once it failed more days ago than this; a
    cancelled run never counts as failed.
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
