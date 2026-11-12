// The log of one step, beside the canvas: its prompt, what the agent said, its tool calls with their output, or a command's
// output. It follows the step while it runs (the view sticks to the bottom until the reader scrolls up) and shows the log as it
// stood at a replay's position when the run is being replayed. Everything is drawn as text: a log holds what an agent wrote.
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { formatCount } from "../app/format.js";
import { NodeRows } from "./NodeRows.js";
import { describeFacts } from "./node-details.js";
import type { GraphNode } from "./run-graph.js";
import { type Body, type LogEntry, type OutputBlock, buildStepLog } from "./step-log.js";
import { useStepLog } from "./use-step-log.js";

/** How close to the bottom (in pixels) a reader still counts as following the tail. */
const FOLLOW_SLACK_PX = 40;

/** The text of a body, or what stands in its place when it was removed or cut. */
function Text({ body, className }: { body: Body; className?: string }) {
  if (body.text === undefined) return <p className="gone">The text of this content was removed by retention ({formatCount(body.chars)} characters).</p>;
  return (
    <>
      <pre className={className}>{body.text}</pre>
      {body.truncated && <p className="gone">Cut: the log keeps the first {formatCount(body.text.length)} of {formatCount(body.chars)} characters.</p>}
    </>
  );
}

function Output({ blocks }: { blocks: OutputBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => (
        <div key={i} className={`output ${block.stream ?? "tool"}`}>
          {block.stream !== undefined && <span className="stream">{block.stream}</span>}
          <Text body={block} />
        </div>
      ))}
    </>
  );
}

function Entry({ entry, reprompt }: { entry: LogEntry; reprompt: boolean }) {
  switch (entry.kind) {
    case "prompt":
      return (
        <section className="entry prompt">
          <h3>{reprompt ? "Re-prompt" : "Prompt"}</h3>
          <Text body={entry} />
        </section>
      );
    case "message":
      return (
        <section className="entry message">
          <h3>Agent</h3>
          <Text body={entry} />
        </section>
      );
    case "tool":
      return (
        <section className="entry tool">
          <h3>
            <span className="kind">{entry.title.startsWith("$ ") ? "Command" : "Tool"}</span> <code>{entry.title}</code>
          </h3>
          {entry.args !== undefined && <pre className="args">{entry.args}</pre>}
          <Output blocks={entry.output} />
        </section>
      );
    case "output":
      return (
        <section className="entry tool">
          <h3>Output</h3>
          <Output blocks={entry.output} />
        </section>
      );
  }
}

export interface StepLogPanelProps {
  runId: string;
  node: GraphNode;
  /** The clock in ms, for the duration of a step that is still running. */
  now: number;
  /** Follow the step live. False for a step that ended, and during a replay. */
  live: boolean;
  /** During a replay, the log line the replay has reached: the panel shows the log up to it. Undefined: everything. */
  upTo?: number;
  onClose(): void;
}

export function StepLogPanel({ runId, node, now, live, upTo, onClose }: StepLogPanelProps) {
  const feed = useStepLog(runId, node.id, live);
  const log = useMemo(() => buildStepLog(feed.items, { upTo }), [feed.items, upTo]);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(live); // a step that is still going is followed at its tail; a finished one is read from its start

  // Follow the tail: after new content, go to the bottom, unless the reader scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [log.count]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return; // Escape there belongs to the control (the replay slider and speed, the copied command)
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = describeFacts(node, now);
  let body: ReactNode;
  if (feed.status === "loading") body = <p className="notice">Reading the step…</p>;
  else if (feed.status === "error") {
    body = (
      <p className="notice" role="alert">
        The log of this step could not be read: {feed.error}
      </p>
    );
  } else if (log.attempts.length === 0) {
    body = <p className="notice">{live ? "Waiting for the step to write something…" : upTo !== undefined && feed.items.length > 0 ? "Nothing of this step is written at this point of the replay." : "This step wrote no content."}</p>;
  } else {
    body = log.attempts.map((attempt) => (
      <div key={attempt.attemptId} className="attempt">
        {log.attempts.length > 1 && <h2>Attempt {attempt.number}</h2>}
        {attempt.entries.map((entry, i) => (
          <Entry key={entry.id} entry={entry} reprompt={entry.kind === "prompt" && attempt.entries.slice(0, i).some((e) => e.kind === "prompt")} />
        ))}
      </div>
    ));
  }

  return (
    <aside className="step-panel" aria-label={`Log of ${node.label}`}>
      <header>
        <h2 title={node.label}>{node.label}</h2>
        <span className={`tail${live ? " live" : ""}`}>{live ? "tailing" : upTo !== undefined ? "replay" : ""}</span>
        <button type="button" className="btn close" onClick={onClose} aria-label="Close the log">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <NodeRows rows={rows} className="facts" />
      <div
        className="log"
        ref={scroller}
        role="log"
        aria-live="off" // a tail of many lines a second is not something to announce
        tabIndex={0}
        aria-label="Step log"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
        }}
      >
        {body}
      </div>
    </aside>
  );
}
