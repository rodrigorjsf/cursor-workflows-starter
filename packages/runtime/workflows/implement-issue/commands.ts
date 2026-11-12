// Every command implement-issue runs (the tests of the TDD loop, `git`, `gh`) goes through `ctx.exec`: it never blocks the
// process (status and cancel stay responsive), it is killed at its timeout, and the run's event log shows it as a step node.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "../../src/runtime/workflow.js";

/** `ctx.exec`. */
export type Exec = (command: string, args?: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** How long a command may run before it is killed. */
export interface CommandTimeouts {
  /** Local `git`: a stuck hook or lock, never a network wait. */
  localMs: number;
  /** `git push` and every `gh` call: a credential prompt or a stalled connection must fail the step, not hang the run. */
  networkMs: number;
}

/** What a command that had to succeed did instead. `result` is what `ctx.exec` handed back. */
export class CommandError extends Error {
  constructor(
    readonly line: string,
    readonly result: ExecResult,
    timeoutMs: number,
  ) {
    super(failureMessage(line, result, timeoutMs));
    this.name = "CommandError";
  }
}

function failureMessage(line: string, r: ExecResult, timeoutMs: number): string {
  if (r.timedOut) return `${line} timed out after ${timeoutMs / 1000}s`;
  if (r.error) return `${line} could not start: ${r.error}`;
  const output = r.tail.trim().slice(-1000);
  return `${line} ${r.exitCode === null ? "was killed" : `exited with code ${r.exitCode}`}${output ? `: ${output}` : ""}`;
}

/** A command's output is read whole, but not without limit: this is what the old synchronous calls allowed (`maxBuffer`). */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * The commands of implement-issue. `git` and `gh` answers are read from a file, not from `ExecResult.tail`: the tail holds
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
    throw new CommandError(commandLine("git", args), r, this.timeouts.localMs);
  }

  /** `git push`: a network command. */
  async push(cwd: string, ...args: string[]): Promise<void> {
    await this.succeed("git", ["push", ...args], cwd, this.timeouts.networkMs);
  }

  /** `gh` in `cwd`, which has to succeed; returns all of its stdout. */
  async gh(cwd: string, ...args: string[]): Promise<string> {
    return this.succeedRead("gh", args, cwd, this.timeouts.networkMs);
  }

  /**
   * A `gh` query that fails with a known message when there is nothing to find (`gh pr view` on a branch without a PR).
   * Returns its stdout, or undefined for "nothing found". Any other failure (an auth error, a network stall) is an error.
   */
  async ghOrNothing(cwd: string, nothing: RegExp, ...args: string[]): Promise<string | undefined> {
    const r = await this.read("gh", args, cwd, this.timeouts.networkMs);
    if (r.ok) return r.stdout;
    if (r.exitCode === 1 && nothing.test(r.tail)) return undefined;
    throw new CommandError(commandLine("gh", args), r, this.timeouts.networkMs);
  }

  private options(command: string, args: string[], cwd: string, timeoutMs: number): ExecOptions {
    return { cwd, timeoutMs, label: `${command} ${args.slice(0, command === "gh" ? 2 : 1).join(" ")}` };
  }

  private async succeed(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
    const r = await this.exec(command, args, this.options(command, args, cwd, timeoutMs));
    if (!r.ok) throw new CommandError(commandLine(command, args), r, timeoutMs);
  }

  private async succeedRead(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
    const r = await this.read(command, args, cwd, timeoutMs);
    if (!r.ok) throw new CommandError(commandLine(command, args), r, timeoutMs);
    return r.stdout;
  }

  /** Runs the command with its stdout going to a file, and returns the result with the whole stdout. */
  private async read(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecResult & { stdout: string }> {
    const dir = mkdtempSync(join(tmpdir(), "wf-stdout-"));
    const file = join(dir, "stdout");
    try {
      // The path goes in the environment, not in the arguments: the node's id in the log comes from the arguments, and a
      // resume has to number the same call alike.
      const result = await this.exec("bash", ["-c", 'exec "$@" >"$WF_STDOUT"', "read", command, ...args], {
        ...this.options(command, args, cwd, timeoutMs),
        env: { WF_STDOUT: file },
      });
      if (existsSync(file) && statSync(file).size > MAX_STDOUT_BYTES) throw new Error(`${commandLine(command, args)}: the output is larger than ${MAX_STDOUT_BYTES / 1024 / 1024} MiB`);
      return { ...result, stdout: existsSync(file) ? readFileSync(file, "utf8") : "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The command as one line, for an error message. */
const commandLine = (command: string, args: string[]) => `${command} ${args.join(" ")}`.slice(0, 200);
