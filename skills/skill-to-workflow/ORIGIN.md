# Origin cases

Reference for `/skill-to-workflow`, for origins that bring one of these cases. The reference conversion,
`packages/runtime/workflows/implement-issue.ts` (with `packages/runtime/workflows/implement-issue/`), has an example
of each case, except "Origin subagent".

## Conversation with the user

The origin skill talks to the user in three ways:

| In the origin | In the workflow |
|---|---|
| Asks for an input ("what is the fixed point?", "where is the spec?") | `args`, or a value the code derives (base commit, issue via `gh`) |
| Asks for approval of an intermediate result ("confirm the seams with the user") | A **checkpoint** across two runs of the same workflow: recipe `Checkpoint em dois runs` in `docs/05-escrevendo-workflows.md` (in `implement-issue`, `seams-proposed` and `approveSeams`) |
| Open conversation (interview, brainstorming) | Stays a skill; goes into the report as not converted |

A step that presents options to the user and recommends one ("compare the designs and recommend") becomes a judge
step with a schema, and its result is what the checkpoint shows.

## Another skill cited and reference files

- **A skill cited by another** (`tdd` says to use the `codebase-design` vocabulary): the step runs without it (with
  `settingSources: []`, no skill is loaded). Paraphrase the passage the step uses into a constant imported by every
  prompt that needs it (`DESIGN_VOCABULARY` in `packages/runtime/workflows/implement-issue/prompts.ts`).
- **A reference file next to the `SKILL.md`** (`mocking.md`, `DESIGN-IT-TWICE.md`): the passage that changes the
  step's behavior becomes part of its constant; the rest stays out.
- **Conditional reading** ("read `GLOSSARY.md`, if it exists"): the code checks with `existsSync` and lists the paths
  that exist in the prompt.

## Sub-agents the skill fires

Skills such as `code-review` (one sub-agent per axis) and "Design it twice" (three designers with different
constraints) fire sub-agents in parallel. In the workflow:

- one step per sub-agent in `ctx.parallel`, with each one's briefing in a constant and, in the prompt, what the skill
  said to paste (diff, smell baseline);
- the input the skill said the sub-agent should fetch (`git diff` since the base, the issue) is computed by the code
  and goes in the prompt; the sub-agent keeps read-only tools, without `shell`;
- the code checks the minimum number of results (`design-failed` with fewer than 2 designs, `review-failed` if an
  axis fails);
- the skill's aggregation becomes code (each axis with its own report, side by side; recipe `Review em eixos`) or a
  judge step with a schema (choose or combine designs).

## Third-party skill

- Check the skill's license and that of whoever it credits (its `CREDITS.md` or `metadata`; `pr` credits `show-me`).
- Paraphrase the instructions into the constants and cite origin, version, author and license in the header of the
  prompts module and in `CREDITS.md`.
- The original skill stays as it is: in a plugin cache, the next update would undo any edit.

## Origin subagent

Besides `name`, `description`, `model` and the body as the prompt:

- In Cursor, `readonly`/`is_background`. `model: inherit` (the default) uses the parent agent's model
  ([DOC](https://cursor.com/docs/subagents#configuration-fields)). In SDK runs, the doc lists neither `readonly` nor
  `is_background`, neither in `.cursor/agents/*.md` (only `name`, `description` and `model`) nor in the inline
  `agents`. So `readonly: true` becomes a read-only `tools` allowlist (`["read","grep","glob","ls"]`).
- In Claude Code, `tools`/`disallowedTools`, `permissionMode` (ignored in plugin subagents), `skills`, `maxTurns`,
  `isolation: worktree` and `effort`. `model: inherit` uses the **main conversation's** model, which in a nested
  subagent may not be the parent's. A `model` passed on the invocation takes precedence, and with
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on, Claude Code ignores the field
  ([DOC](https://code.claude.com/docs/en/sub-agents)).
- `model: inherit` becomes an explicit tier (rule 4 of `cursor-workflow-authoring`).

| Claude Code field | In the workflow |
|---|---|
| `isolation: worktree` | `git worktree add` in the code and the step's `cwd` pointing to it |
| `maxTurns` | A short `timeoutMs`, with `retries: 0` and a low `schemaRetries` for a hard cap: the engine redoes the step that times out, and each schema re-prompt has its own `timeoutMs` (the SDK exposes no turn cap) |
| `effort` | `model.params` (e.g. `[{ id: "reasoning_effort", value: "high" }]`), if the model offers it; check with `npm run models` |
| `tools` / `disallowedTools` | The SDK's `tools` / `disallowedTools` (different names: `Read`→`read`, `Bash`→`shell`, `Edit`/`Write`→`edit`) |
| `mcpServers` | The step's `mcpServers`, only with the servers it uses |
| `skills` | Section "Another skill cited and reference files" |

A field with no row here (`permissionMode`, `hooks`, `memory`, `background`, `is_background`…) goes into the list of
what was not converted (step 6 of the skill), with the reason.
