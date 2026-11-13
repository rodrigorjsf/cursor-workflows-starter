# Rules

A workflow is **deterministic**: code decides what runs, when and how many times; the model executes each step. If code
can make a decision, code **makes** it.

| Decision | By code | By model |
|---|---|---|
| Which model to use | Issue label, diff size, `ctx.budget` | Only without an objective signal: a cheap classifier with a schema |
| Whether a step runs | An `if` over data | Never |
| How many repetitions | A loop with a cap | Never |
| Whether it passed | Exit code of tests, lint, typecheck | Review as a *second* layer, never the only one |
| External effects (commit, PR) | Always | Never |

## The nine rules

1. **Prompt and options are the step's key.** The journal (resume) recognizes a step by the hash of the prompt and of
   the call fingerprint (model, schema, `cwd`, `tools`, `disallowedTools`, `agents`, `settingSources`), plus the order
   in which that hash appears in the run. `label`, `timeoutMs`, `mcpServers` and `sandbox` stay out. The `memo` and the
   provider's prompt cache also depend on the prompt. Build the prompt from instructions in module constants plus
   deterministic data only: `args`, step results, and what the code computes from them and from disk (test output,
   diff). A date enters through `args`, not through `Date.now()`. Give a worktree a path derived from the item
   (`wf/migrate-<item>`). Two calls that must stay distinct (the same step in different rounds) carry the round in the
   prompt: without it, round 2 of a resume gets round 1's saved answer.
2. **A schema on every step whose result the code reads**, with only the fields it reads. Free text only at the end, or
   for the human.
3. **Verification is code.** Run tests, lint and `git diff` with `ctx.exec` inside the workflow; the exit code
   decides the next step. Run tests in the caller's environment (`bash -c`, not `bash -lc`: a login profile can change
   the PATH and fail the suite for reasons that are not the code). Fix loops always have a cap
   (`for (round = 1; round <= N; ...)`).
4. **The model is chosen in code.** Use a `tier → ModelSelection` map and confirm each id with `npm run models`: an id
   outside the account's catalog fails the step. Auto is `default`; with it the metrics record `default`, not the
   model the router picked, so compare models with explicit ids.
5. **Parallel writes only with isolation.** Two simultaneous steps cannot edit the same files. Create a `git worktree`
   per item and pass it as `cwd`.
6. **External effects stay in code.** Commit, push, opening a PR (a merge request on GitLab) and commenting on an issue
   are done with `git` and the forge's CLI, `gh` or `glab` (through `ctx.exec`, runtime-api.md "Forge commands"), in the
   workflow, after the checks. Everything that leaves the machine first passes a **secrets guard**, because an
   issue body with a prompt injection can lead a step to copy `~/.cursor/sdk/auth.json` into the worktree and the
   sandbox does not restrict reads. The guard: before the commit, reset any commits an agent made (`git reset --soft`
   to the base, keeping the tree) and scan the lines added since the base for every credential format the event-log
   redactor knows (`CREDENTIAL_FORMATS` in `src/runtime/redaction.ts`: `crsr_` and `sk-` keys, GitHub, GitLab, AWS, npm, Slack,
   Google and Stripe tokens, private key blocks), the SDK's saved key (or the one in `CURSOR_API_KEY`), the value of any
   secret-named environment variable, and files named `auth.json`, `.env` or `.env.*`; before publishing any text
   (PR body, comment) scan it with the same text rules. A hit stops exactly the effect that would have carried the
   text out, and the run returns `status: "secret-blocked"` with a `reason` naming only the rule that fired, never the
   snippet. On GitLab, text a model wrote also acts: a line that starts with a quick action (`/close`, `/merge`, ...)
   runs as that command under the account that posts it, so show such a line as code before it goes into a merge
   request description or a note. A security review is a second layer, not the only one.
7. **Cuts and failures are always explicit.** When limiting coverage (top-N, sampling), record with `ctx.log` what was
   left out. `ctx.parallel` and `ctx.pipeline` turn failures into `null`: when the result is required (a mandatory
   review, for example), check the `null`s and end the run with an explicit failure `status`.
8. **Idempotent effects.** A resume re-executes the code outside the agent steps, and the journal returns a step's
   result, not its effect on disk. Protect commit (`git diff --cached --quiet`), push and PR creation (`gh pr view`
   before `gh pr create`; `glab mr list --source-branch <branch>` before `glab mr create`). If the code checks the disk
   between steps, keep the progress per item (recipes.md, "Resume with invariants").
9. **Compose with shared TypeScript functions**, called from `run`.

## What the code guarantees and what is only asked

| Rule | Where | Strength |
|---|---|---|
| Commit, push and PR done by the code, after the checks | Workflow code | Guaranteed |
| Secrets guard before the commit, the issue comment and the PR body | Workflow code | Checked by code, only for those formats |
| Tests in the caller's environment | The test runner helper | Guaranteed |
| Write only inside the repository | Step instructions | **Only asked in the prompt** (a fix step once edited a file outside the repo to "repair" the environment) |
| Sandbox (`sandbox: true`) | Step option | Untested here |

Put every "must hold" rule in code. When a rule can only be a prompt line, say so in a comment so the next author does
not rely on it.

## Writing step prompts

- **Self-contained:** a step sees neither the chat history nor earlier steps. Pass in the prompt everything it needs,
  including earlier steps' results.
- **One responsibility per step.** "Plan" and "implement" are two steps; it helps small models.
- **State the target, and the guard beside it:** "change only test files", "the workflow commits: do not run git". A
  prohibition alone reminds the model of the forbidden behavior; the code checks what matters (recipes.md,
  "Invariants between steps").
- **Lean schema:** only the fields the code reads.
