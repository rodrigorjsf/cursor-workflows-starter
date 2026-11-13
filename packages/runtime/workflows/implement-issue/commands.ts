// Every command implement-issue runs (the tests of the TDD loop, `git`, the forge's CLI) goes through `ctx.exec`: it never blocks
// the process (status and cancel stay responsive), it is killed at its timeout, and the run's event log shows it as a step node.
// The forge's CLI is named in forge.ts alone: this file knows only that such a CLI is a network command (`forgeRead`).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "../../src/runtime/workflow.js";

/** `ctx.exec`. */
export type Exec = (command: string, args?: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** How long a command may run before it is killed. */
export interface CommandTimeouts {
  /** Local `git`: a stuck hook or lock, never a network wait. Absent: `ctx.exec`'s default, the workflow's `execTimeoutMs`. */
  localMs?: number;
  /** `git push` and every forge CLI call: a credential prompt or a stalled connection must fail the step, not hang the run. */
  networkMs: number;
}

/** How long local `git` (add, diff, commit with hooks…) may run: past this a hook or a lock is stuck. `wf gc`'s default; a run's own local git takes the workflow's `execTimeoutMs`. */
export const LOCAL_GIT_TIMEOUT_MS = 5 * 60_000;
/** The default for how long `git push`, `git ls-remote` and every forge CLI call may run, in seconds. */
export const NETWORK_TIMEOUT_SEC = 120;
/**
 * The default for how long `wf gc` leaves a cloud snapshot branch alone after the last event of its run, in hours. A step that
 * ends deletes its snapshot; one that is still there belongs to a run that died, and a cloud agent that the dead process started
 * may only now be reading the ref it starts from. How late it reads is not known (nothing has measured it against the real API),
 * so the wait is long: a day costs nothing, a throwaway ref on the remote is all that waits.
 */
export const SNAPSHOT_GRACE_HOURS = 24;

/** What a command that had to succeed did instead. `result` is what `ctx.exec` handed back. */
export class CommandError extends Error {
  readonly line: string;
  constructor(
    command: string,
    args: string[],
    readonly result: ExecResult,
    timeoutMs: number | undefined,
  ) {
    const line = `${command} ${args.join(" ")}`.slice(0, 200);
    super(failureMessage(line, result, timeoutMs));
    this.name = "CommandError";
    this.line = line;
  }
}

function failureMessage(line: string, r: ExecResult, timeoutMs: number | undefined): string {
  if (r.timedOut) return `${line} timed out ${timeoutMs === undefined ? "(the workflow's execTimeoutMs)" : `after ${timeoutMs / 1000}s`}`;
  if (r.error) return `${line} could not start: ${r.error}`;
  const output = r.tail.trim().slice(-1000);
  return `${line} ${r.exitCode === null ? "was killed" : `exited with code ${r.exitCode}`}${output ? `: ${output}` : ""}`;
}

/** The remote the workflow pushes its branches to, and the default of the others its commands take. */
export const ORIGIN = "origin";

/** Every branch the workflow creates starts with this, and it force-pushes no other (`Commands.pushOwned`). */
export const WORKFLOW_BRANCH_PREFIX = "wf/";

/** Where the runs' worktrees are in the target repo: one per branch, named after it. `wf gc` removes none outside it. */
export const worktreesDirIn = (cwd: string) => join(cwd, ".workflows", "worktrees");

/** The worktree of `branch` in the target repo. */
export const worktreeOf = (cwd: string, branch: string) => join(worktreesDirIn(cwd), branch.replaceAll("/", "-"));

/** Throws unless `branch` is one the workflow owns: it never force-pushes or deletes any other. */
function assertOwned(branch: string, action: string, verb: string): void {
  if (!branch.startsWith(WORKFLOW_BRANCH_PREFIX)) throw new Error(`refusing to ${action}: the workflow only ${verb} branches under ${WORKFLOW_BRANCH_PREFIX}`);
}

/** A command's output is read whole, but not without limit: this is what the old synchronous calls allowed (`maxBuffer`). */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/** The words of a forge CLI call that name its node in the run's log: `<cli> issue view`, not just `<cli> issue`. */
const FORGE_LABEL_WORDS = 2;

/**
 * The commands of implement-issue. `git` and forge CLI answers are read from a file, not from `ExecResult.tail`: the tail holds
 * only the last 32768 characters of stdout and stderr mixed, and a diff, a file list or an issue with its comments is
 * longer, and one warning on stderr would corrupt a value that is parsed.
 */
export class Commands {
  constructor(
    readonly exec: Exec,
    private readonly timeouts: CommandTimeouts,
  ) {}

  /** `git` in `cwd`, which has to succeed. */
  async git(cwd: string, ...args: string[]): Promise<void> {
    await this.succeed("git", args, cwd, this.timeouts.localMs);
  }

  /** `git` in `cwd`, which has to succeed; returns all of its stdout. */
  async gitRead(cwd: string, ...args: string[]): Promise<string> {
    return this.succeedRead("git", args, cwd, this.timeouts.localMs);
  }

  /** `git` whose exit code is the answer (`diff --quiet`, `rev-parse --verify --quiet`): 0 is yes, 1 is no, anything else is an error. */
  async gitIs(cwd: string, ...args: string[]): Promise<boolean> {
    const r = await this.exec("git", args, this.options("git", args, cwd, this.timeouts.localMs));
    if (r.ok) return true;
    if (r.exitCode === 1) return false;
    throw new CommandError("git", args, r, this.timeouts.localMs);
  }

  /** `git push`: a network command. */
  async push(cwd: string, ...args: string[]): Promise<void> {
    await this.succeed("git", ["push", ...args], cwd, this.timeouts.networkMs);
  }

  /** The commit `branch` points at on the origin, or undefined when the origin has no such branch. A network command. */
  async remoteBranchHead(cwd: string, branch: string): Promise<string | undefined> {
    const out = await this.succeedRead("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], cwd, this.timeouts.networkMs);
    return out.trim().split(/\s+/)[0] || undefined;
  }

  /**
   * Pushes `branch` with a force that only replaces what the workflow expects the origin to have: `expected` is the commit it
   * believes `origin/<branch>` points at (undefined: the origin must not have the branch). A branch the workflow does not own
   * is never pushed this way, so the workflow cannot overwrite a branch a human owns. If the origin moved since `expected`, git
   * refuses ("stale info") and the push fails.
   */
  async pushOwned(cwd: string, branch: string, expected: string | undefined): Promise<void> {
    assertOwned(branch, `force-push ${branch}`, "pushes");
    await this.push(cwd, `--force-with-lease=${branch}:${expected ?? ""}`, "-u", "origin", branch);
  }

  /**
   * Every branch `remote` (the origin by default) has under `prefix` (the workflow's own by default), by name, with the commit each
   * points at. A network command. Empty when the repository has no such remote: there is no remote branch to find.
   */
  async remoteOwnedHeads(cwd: string, remote = ORIGIN, prefix = WORKFLOW_BRANCH_PREFIX): Promise<Map<string, string>> {
    if (!(await this.gitIs(cwd, "config", "--get", `remote.${remote}.url`))) return new Map();
    const out = await this.succeedRead("git", ["ls-remote", "--heads", remote, `refs/heads/${prefix}*`], cwd, this.timeouts.networkMs);
    const heads = new Map<string, string>();
    for (const line of out.split("\n")) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref?.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
    }
    return heads;
  }

  /**
   * Deletes `branch` from `remote` (the origin by default), but only if it still points at `expected` (a lease, like `pushOwned`):
   * a commit pushed since is not deleted. Like the push, it is restricted to the branches the workflow owns.
   */
  async deleteOwned(cwd: string, branch: string, expected: string, remote = ORIGIN): Promise<void> {
    assertOwned(branch, `delete ${branch} from ${remote}`, "deletes");
    await this.push(cwd, `--force-with-lease=${branch}:${expected}`, remote, `:refs/heads/${branch}`);
  }

  /** The forge's CLI (`cli`) in `cwd`, which has to succeed; returns all of its stdout. A network command. */
  async forgeRead(cli: string, cwd: string, ...args: string[]): Promise<string> {
    return this.succeedRead(cli, args, cwd, this.timeouts.networkMs, FORGE_LABEL_WORDS);
  }

  /**
   * A forge CLI query that fails with a known message when there is nothing to find (a PR lookup on a branch that has none).
   * Returns its stdout, or undefined for "nothing found". Any other failure (an auth error, a network stall) is an error.
   */
  async forgeReadOrNothing(cli: string, cwd: string, nothing: RegExp, ...args: string[]): Promise<string | undefined> {
    const r = await this.read(cli, args, cwd, this.timeouts.networkMs, FORGE_LABEL_WORDS);
    if (r.ok) return r.stdout;
    if (r.exitCode === 1 && nothing.test(r.tail)) return undefined;
    throw new CommandError(cli, args, r, this.timeouts.networkMs);
  }

  private options(command: string, args: string[], cwd: string, timeoutMs: number | undefined, labelWords = 1): ExecOptions {
    return { cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }), label: `${command} ${args.slice(0, labelWords).join(" ")}` };
  }

  private async succeed(command: string, args: string[], cwd: string, timeoutMs: number | undefined): Promise<void> {
    const r = await this.exec(command, args, this.options(command, args, cwd, timeoutMs));
    if (!r.ok) throw new CommandError(command, args, r, timeoutMs);
  }

  private async succeedRead(command: string, args: string[], cwd: string, timeoutMs: number | undefined, labelWords?: number): Promise<string> {
    const r = await this.read(command, args, cwd, timeoutMs, labelWords);
    if (!r.ok) throw new CommandError(command, args, r, timeoutMs);
    return r.stdout;
  }

  /** Runs the command with its stdout going to a file, and returns the result with the whole stdout. */
  private async read(command: string, args: string[], cwd: string, timeoutMs: number | undefined, labelWords?: number): Promise<ExecResult & { stdout: string }> {
    const dir = mkdtempSync(join(tmpdir(), "wf-stdout-"));
    const file = join(dir, "stdout");
    try {
      // The path goes in the environment, not in the arguments: the node's id in the log is derived from the arguments, and
      // a temp path would give the same call another id every time.
      const result = await this.exec("bash", ["-c", 'exec "$@" >"$WF_STDOUT"', "read", command, ...args], {
        ...this.options(command, args, cwd, timeoutMs, labelWords),
        env: { WF_STDOUT: file },
      });
      if (existsSync(file) && statSync(file).size > MAX_STDOUT_BYTES) throw new Error(`${command} ${args[0] ?? ""}: the output is larger than ${MAX_STDOUT_BYTES / 1024 / 1024} MiB`);
      return { ...result, stdout: existsSync(file) ? readFileSync(file, "utf8") : "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
