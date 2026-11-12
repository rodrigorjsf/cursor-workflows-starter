# The config files

The kit reads two JSON files fresh at every run start, so an edit applies to the next run with no restart.

| File | Holds | Who edits it |
|---|---|---|
| `~/.cursor-workflows/config.json` (global) | `caps`: hard limits for every run on this machine, plus the user's own preferences | the user |
| `.agents/workflows/config.json` (repo, committed) | preferences per workflow and role, and `kit`, the accepted kit version range | the repo's team |

Both accept `$schema` (editor autocomplete and validation) and `$comment` anywhere. A key the schema does not know is an
error that names the file and the field path, such as `/workflows/implement-issue/roles/review/retries`.

The schema is the full list of keys, with each key's meaning and default in its `description`:
`~/.cursor-workflows/kit/packages/runtime/schema/config.schema.json`, the file the config's `$schema` URL names. Read
the key there before you write it. The sections below name every key it accepts.

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
- `execTimeoutMs`: the default time limit of a command the workflow runs with `ctx.exec`.
- `roles.<role>`: `model` (`id`; `params`, a list of `{ id, value }` such as `reasoning_effort`; `maxMode`),
  `timeoutMs`, `retries`, `schemaRetries`, `maxTokensPerStep`, `settingSources`, and for cloud steps:
  - `location`: `local` (default) or `cloud`. `cloud` runs the role's steps on a Cursor cloud agent, against a snapshot
    of the worktree pushed to `cloud.remote`. It applies only when the global cap `allowedLocations` includes `cloud`
    (otherwise the step runs locally and the request is a violation), and a role the workflow marks `never` is refused.
  - `resultVia`: how a cloud step returns its structured result, `json-block` (default) or `artifact`.

  A workflow declares its roles; a role it does not declare is an error.
- `labels.<glob>`: the same preferences for steps that have no role, matched against the step's label (`location` and
  `resultVia` apply to roles only).
- `settings`: the workflow's own settings, by the names it declares in `meta.settings`, set only in the two files; a
  name it does not declare is an error. `implement-issue`'s: `sliceCaps` (per tier: `LOW`, `MED`, `HIGH`),
  `extraSlices`, `fixRounds`, `redGreenAttempts`, `maxDiffChars`, `labelTiers`, `maxStepCrashes`, `testTimeoutSec`,
  `networkTimeoutSec`, and the `wf gc` ages `gcFailedAfterDays` and `gcSnapshotGraceHours`. A setting set in a higher
  layer replaces the lower one whole.

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
