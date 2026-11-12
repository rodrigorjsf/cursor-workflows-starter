# The config files

The kit reads two JSON files fresh at every run start, so an edit applies to the next run with no restart.

| File | Holds | Who edits it |
|---|---|---|
| `~/.cursor-workflows/config.json` (global) | `caps`: hard limits for every run on this machine, plus the user's own preferences | the user |
| `.agents/workflows/config.json` (repo, committed) | preferences per workflow and role, and `kit`, the accepted kit version range | the repo's team |

Both accept `$schema` (editor autocomplete and validation) and `$comment` anywhere. A key the schema does not know is an
error that names the file and the field path, such as `/workflows/implement-issue/roles/review/retries`.

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

`null` switches a cap off. An absent key inherits from the layer below. Zero is zero.

The repo file and the chat can only **tighten** a cap: a number takes the smaller value, a list takes the
intersection. A request to loosen is recorded as a `violation` and has no effect. A `caps` block in the repo file is a
violation too.

## Preferences

Under `workflows.<name>`:

- `maxTokens`, `maxTokensPerStep`, `maxCents`, `concurrency`: limits for that workflow, held under the caps.
- `roles.<role>`: `model` (`id`, `params` such as `reasoning_effort`, `maxMode`), `timeoutMs`, `retries`,
  `schemaRetries`, `maxTokensPerStep`, `settingSources`. A workflow declares its roles; a role it does not declare is an
  error.
- `labels.<glob>`: the same preferences for steps that have no role, matched against the step's label.

`WF_MODEL_<ROLE>` environment variables (`WF_MODEL_REVIEW`, `WF_MODEL_IMPLEMENT_LOW`) set a role's model without a
file edit.

Precedence, lowest to highest: code defaults, global file, repo file, environment, command-line flags, the chat's
`overrides`. The caps clamp the result.

## Change a setting

`wf config show <workflow>` prints `files` (the two paths, each found or not) and, under `workflows.<workflow>`, `config`
(the values in force: `limits`, `caps` and `roles`), `provenance` (the layer each value came from, by JSON pointer into
`config`) and `violations`.

1. Run `wf list`, then `wf config show <workflow>`. Done when you know the role name under `config.roles` and its
   current value.
2. Edit `.agents/workflows/config.json` (repo-wide, committed) or `~/.cursor-workflows/config.json` (this machine).
   Done when the file is valid JSON and uses only keys the schema knows.
3. Run `wf config show <workflow>` again. Done when `provenance` shows the layer you edited for the value you changed,
   and `violations` is empty or reported to the user.
4. A model id must exist in the account's catalog: `wf models` lists them, and `wf doctor` checks every id the config
   uses.
