// CommandRunner: runs one command a workflow needs (tests, git, gh) as an asynchronous child process. It knows nothing of
// runs or events: it spawns, hands the output to a callback as it arrives, keeps the tail, and never leaves a process
// behind. The engine turns a call into a step node and the output into `content` events (`ctx.exec`).
import { type ChildProcess, spawn } from "node:child_process";
import type { ExecOutcome, OutputStream } from "./events.js";

/** How much of a command's output a call hands back: the last characters of stdout and stderr, in arrival order. */
export const TAIL_MAX_CHARS = 32_768;

/** How much of one command's output the event log keeps. What follows is dropped from the log (the call's `tail` still has the end), and the command's end event says so. */
export const EXEC_LOG_MAX_CHARS = 262_144;
/** How often the output a command has written so far goes to the event log while it runs. */
export const EXEC_FLUSH_MS = 250;

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Added to this process's own environment; a variable set to `undefined` is left out. */
  env?: Record<string, string | undefined>;
  /** The command is killed this long after it started. */
  timeoutMs: number;
  /** Aborting it kills the command. */
  signal?: AbortSignal;
}

/** How a command ended. */
export interface CommandOutcome {
  /** `exit`: the process ended by itself, with any code. `timeout`, `cancelled`: it was killed. `spawn-error`: it never ran. */
  outcome: ExecOutcome;
  /** The exit code. `null` when the process was killed by a signal or never started. */
  exitCode: number | null;
  /** The signal that ended the process, when one did. */
  signal: NodeJS.Signals | null;
  /** Why the process could not start. */
  error?: string;
  /** The last `TAIL_MAX_CHARS` characters of the output. */
  tail: string;
  /** Everything the command wrote, in characters. */
  outputChars: number;
}

/** A command asked to stop gets SIGTERM, and this long to clean up (a `git` removing its lock file) before SIGKILL. */
export const KILL_GRACE_MS = 2_000;
/** After the process has ended, how long to wait for its pipes to close: a background process it left behind can hold them open. */
const DRAIN_GRACE_MS = 1_000;

/** Each command runs in its own process group (not on Windows), so that a kill reaches what the command started too. */
const OWN_GROUP = process.platform !== "win32";
/** The commands running now: a process that exits without having ended them (a second SIGTERM) must not leave them behind. */
const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (OWN_GROUP && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

/**
 * Runs the command and resolves when it has ended. Never rejects: failures are in the outcome. `onOutput` gets each decoded
 * chunk, as it arrives. At the timeout, or when `signal` aborts, the command's process group gets SIGTERM and, after
 * `KILL_GRACE_MS`, SIGKILL.
 */
export function runCommand(spec: CommandSpec, onOutput: (stream: OutputStream, text: string) => void): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let tail = "";
    let outputChars = 0;
    const result = (outcome: ExecOutcome, exitCode: number | null, signal: NodeJS.Signals | null, error?: string): CommandOutcome => ({ outcome, exitCode, signal, ...(error === undefined ? {} : { error }), tail, outputChars });
    if (spec.signal?.aborted) return resolve(result("cancelled", null, null));
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ["ignore", "pipe", "pipe"], detached: OWN_GROUP });
    } catch (err) {
      return resolve(result("spawn-error", null, null, err instanceof Error ? err.message : String(err)));
    }
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on("exit", () => running.forEach((c) => killTree(c, "SIGKILL")));
    }
    running.add(child);

    let outcome: ExecOutcome = "exit";
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (end: CommandOutcome) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      spec.signal?.removeEventListener("abort", onAbort);
      running.delete(child);
      resolve(end);
    };
    const ended = () => result(outcome, exited?.code ?? null, exited?.signal ?? null);
    /**
     * Stops waiting for the pipes and ends the call. Something the command left running still holds them, so its process
     * group is alive: it is killed here, since nothing else would (the call is over, and the exit hook looks at calls
     * in flight only).
     */
    const abandonPipes = () => {
      killTree(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(ended());
    };
    const stop = (why: "timeout" | "cancelled") => {
      if (exited || outcome !== "exit") return; // it ended by itself, or is already being stopped
      outcome = why;
      killTree(child, "SIGTERM");
      timers.push(
        setTimeout(() => {
          killTree(child, "SIGKILL");
          timers.push(setTimeout(abandonPipes, DRAIN_GRACE_MS));
        }, KILL_GRACE_MS),
      );
    };
    const onAbort = () => stop("cancelled");
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => stop("timeout"), spec.timeoutMs));

    for (const stream of ["stdout", "stderr"] as const) {
      const pipe = child[stream]!;
      pipe.setEncoding("utf8");
      pipe.on("data", (text: string) => {
        outputChars += text.length;
        tail = (tail + text).slice(-TAIL_MAX_CHARS);
        onOutput(stream, text);
      });
    }
    child.once("error", (err) => {
      if (child.pid === undefined) finish(result("spawn-error", null, null, err.message));
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      timers.push(setTimeout(abandonPipes, DRAIN_GRACE_MS)); // the pipes normally close at once: `close` ends the call first
    });
    child.once("close", (code, signal) => {
      exited ??= { code, signal };
      finish(ended());
    });
  });
}

export interface OutputLog {
  /** Takes a decoded chunk of one stream. */
  push(stream: OutputStream, text: string): void;
  /** Writes what is complete: whole lines, and a partial line only once it is as long as one event holds. Call it on a timer. */
  flush(): void;
  /** Writes everything left, a partial line included. */
  end(): void;
  /** True when output was dropped because the command passed `logMax`. */
  readonly truncated: boolean;
}

/** The start of the line where a private key block that has not ended begins in `text`, or -1. Its BEGIN line is here and its END line is not. */
function openKeyBlock(text: string): number {
  let open = -1;
  for (const begin of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    const from = begin.index ?? 0;
    if (!/-----END [A-Z ]*PRIVATE KEY-----/.test(text.slice(from))) open = text.lastIndexOf("\n", from) + 1;
  }
  return open;
}

/**
 * Cuts a command's output into the pieces that go to the event log. Redaction sees one piece at a time, so a piece must
 * hold whatever a secret is made of: it ends at a line break (a token printed across two reads of the pipe is redacted
 * whole), a private key block waits for its END line, and a batch longer than `pieceMax` (the event's own limit, past
 * which text is cut) is cut at the last line break that fits. Only a single line longer than `pieceMax` is cut inside.
 * Each stream has its own pending text. At most `logMax` characters are written for the command.
 */
export function outputLog(write: (stream: OutputStream, text: string) => void, limits: { pieceMax: number; logMax: number }): OutputLog {
  const pending: Record<OutputStream, string> = { stdout: "", stderr: "" };
  let written = 0;
  let truncated = false;
  const emit = (stream: OutputStream, text: string) => {
    for (let at = 0; at < text.length; ) {
      const room = limits.logMax - written;
      if (room <= 0) {
        truncated = true;
        return;
      }
      let end = Math.min(at + limits.pieceMax, text.length);
      if (end < text.length) {
        const lineEnd = text.lastIndexOf("\n", end - 1) + 1; // 0 when the batch has no line break before the cut
        if (lineEnd > at) end = lineEnd;
      }
      let piece = text.slice(at, end);
      if (piece.length > room) {
        piece = piece.slice(0, room);
        truncated = true;
      }
      write(stream, piece);
      written += piece.length;
      if (truncated) return;
      at = end;
    }
  };
  return {
    push: (stream, text) => void (pending[stream] += text),
    flush() {
      for (const stream of ["stdout", "stderr"] as const) {
        const open = openKeyBlock(pending[stream]);
        const whole = open >= 0 ? open : pending[stream].lastIndexOf("\n") + 1;
        if (whole > 0) {
          emit(stream, pending[stream].slice(0, whole));
          pending[stream] = pending[stream].slice(whole);
        }
        if (pending[stream].length >= limits.pieceMax) {
          emit(stream, pending[stream]);
          pending[stream] = "";
        }
      }
    },
    end() {
      for (const stream of ["stdout", "stderr"] as const) {
        emit(stream, pending[stream]);
        pending[stream] = "";
      }
    },
    get truncated() {
      return truncated;
    },
  };
}
