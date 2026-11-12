// What a step's panel shows, built from the step's `content` events. Pure: the live panel, the replay and the tests all call the
// same function on the items they have.
//
// A step's content is, per attempt: the prompt, then in order what the agent said (`agent-message`, written when a turn ends),
// its tool calls (`tool-call`, the arguments as JSON) and their output (`command-output`, tied to its call by `callId`); a
// re-prompt is another `prompt`. A `ctx.exec` command is a `tool-call` of the tool `exec` (command, args, cwd) and its output
// in chunks tagged `stdout` or `stderr`. A reader tolerates what it does not know: a kind from a newer kit is left out.
import { shellQuote } from "./shell.js";

/** A `content` event as `GET /api/runs/<runId>/steps/<stepId>/content` gives it, read loosely. */
export interface ContentItem {
  /** The line of the event in the run's log: grows with time, never changes. */
  id: number;
  attemptId: string;
  kind: string;
  tool?: string;
  callId?: string;
  stream?: string;
  /** Absent once retention removed it. */
  text?: string;
  /** Length of the text before it was cut at 32,768 characters; stays after retention. */
  chars?: number;
  /** true when `text` is only the start of the content. */
  truncated?: boolean;
}

/** A piece of text and what is known about it when the text itself is not all there. */
export interface Body {
  text?: string;
  chars: number;
  truncated: boolean;
}

export interface OutputBlock extends Body {
  /** `stdout` or `stderr` for a command of `ctx.exec`; absent for the output of an agent's tool, which joins both. */
  stream?: "stdout" | "stderr";
}

export type LogEntry =
  | ({ kind: "prompt"; id: number } & Body)
  | ({ kind: "message"; id: number } & Body)
  | {
      kind: "tool";
      id: number;
      /** The tool's name, or `$ command args` for a command of `ctx.exec`. */
      title: string;
      /** The arguments, written out; for a command, the directory it ran in. */
      args?: string;
      output: OutputBlock[];
    }
  /** Output whose call has not been seen (a log read from the middle). */
  | { kind: "output"; id: number; output: OutputBlock[] };

export interface AttemptLog {
  attemptId: string;
  /** 1 for the attempt that began first. */
  number: number;
  entries: LogEntry[];
}

export interface StepLog {
  attempts: AttemptLog[];
  /** How many items the log was built from. */
  count: number;
}

const bodyOf = (item: ContentItem): Body => ({ ...(item.text === undefined ? {} : { text: item.text }), chars: item.chars ?? item.text?.length ?? 0, truncated: item.truncated === true });
const blockOf = (item: ContentItem): OutputBlock => ({ ...bodyOf(item), ...(item.stream === "stdout" || item.stream === "stderr" ? { stream: item.stream } : {}) });

/** The title and the arguments line of a tool call, from the JSON the log holds. */
function describeCall(item: ContentItem): { title: string; args?: string } {
  const tool = item.tool ?? "tool";
  let parsed: unknown;
  try {
    parsed = item.text === undefined ? undefined : JSON.parse(item.text);
  } catch {
    return { title: tool, args: item.text }; // not JSON: shown as it was written
  }
  if (tool === "exec" && typeof parsed === "object" && parsed !== null) {
    const { command, args, cwd } = parsed as { command?: unknown; args?: unknown; cwd?: unknown };
    if (typeof command === "string") {
      const words = [command, ...(Array.isArray(args) ? args.map(String) : [])].map(shellQuote);
      return { title: `$ ${words.join(" ")}`, ...(typeof cwd === "string" ? { args: `in ${cwd}` } : {}) };
    }
  }
  // The SDK reports every MCP tool as `mcp`, the tool itself in `toolName`.
  const reached = typeof parsed === "object" && parsed !== null ? (parsed as { toolName?: unknown }).toolName : undefined;
  return { title: typeof reached === "string" ? `${tool}: ${reached}` : tool, ...(parsed === undefined || parsed === null ? {} : { args: JSON.stringify(parsed, null, 2) }) };
}

/** Adds `block` to `blocks`, joining it to the last one when both are the same stream and text is there for both. */
function addOutput(blocks: OutputBlock[], block: OutputBlock): void {
  const last = blocks.at(-1);
  if (last && last.stream === block.stream && (last.text === undefined) === (block.text === undefined)) {
    last.text = last.text === undefined ? undefined : last.text + block.text;
    last.chars += block.chars;
    last.truncated ||= block.truncated;
    if (last.text === undefined) delete last.text;
    return;
  }
  blocks.push(block);
}

/** The log of a step from its content items. `upTo` keeps the items up to that log line (a replay shows the log as it stood). */
export function buildStepLog(items: readonly ContentItem[], options: { upTo?: number } = {}): StepLog {
  const kept = items.filter((i) => options.upTo === undefined || i.id <= options.upTo).sort((a, b) => a.id - b.id);
  const attempts = new Map<string, AttemptLog>();
  /** The tool entry and the standalone output entry of each call, per attempt. */
  const tools = new Map<string, Extract<LogEntry, { kind: "tool" }>>();
  const loose = new Map<string, Extract<LogEntry, { kind: "output" }>>();
  for (const item of kept) {
    let attempt = attempts.get(item.attemptId);
    if (!attempt) {
      attempt = { attemptId: item.attemptId, number: 0, entries: [] }; // numbered once we know which attempts have anything to show
      attempts.set(item.attemptId, attempt);
    }
    const entryOf = (): LogEntry | undefined => {
      switch (item.kind) {
        case "prompt":
          return { kind: "prompt", id: item.id, ...bodyOf(item) };
        case "agent-message":
          return { kind: "message", id: item.id, ...bodyOf(item) };
        case "tool-call": {
          const entry: LogEntry = { kind: "tool", id: item.id, ...describeCall(item), output: [] };
          const key = `${item.attemptId}\n${item.callId ?? item.id}`;
          const early = loose.get(key); // its output came first
          if (early) {
            entry.output = early.output;
            attempt!.entries.splice(attempt!.entries.indexOf(early), 1);
            loose.delete(key);
          }
          tools.set(key, entry);
          return entry;
        }
        case "command-output": {
          const key = `${item.attemptId}\n${item.callId ?? ""}`;
          const owner = item.callId === undefined ? undefined : tools.get(key);
          if (owner) {
            addOutput(owner.output, blockOf(item));
            return undefined;
          }
          const alone = loose.get(key);
          if (alone && item.callId !== undefined) {
            addOutput(alone.output, blockOf(item));
            return undefined;
          }
          const entry: LogEntry = { kind: "output", id: item.id, output: [blockOf(item)] };
          if (item.callId !== undefined) loose.set(key, entry);
          return entry;
        }
        default:
          return undefined; // a kind this code does not know
      }
    };
    const entry = entryOf();
    if (entry) attempt.entries.push(entry);
  }
  // An attempt whose items were all of a kind this code does not know has nothing to show.
  return { attempts: [...attempts.values()].filter((a) => a.entries.length > 0).map((a, i) => ({ ...a, number: i + 1 })), count: kept.length };
}
