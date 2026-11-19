// The log of one step, beside the canvas: its prompt, what the agent said, its tool calls with their output, or a command's
// output. It follows the step while it runs (the view sticks to the bottom until the reader scrolls up) and shows the log as it
// stood at a replay's position when the run is being replayed. Everything is drawn as text: a log holds what an agent wrote.
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { formatCount } from "../app/format.js";
import { commandItemSelector, focusOnClose, focusOnOpen, phaseEntrySelector, restoreFocus } from "./log-focus.js";
import { NodeRows } from "./NodeRows.js";
import { Glyph } from "./nodes.js";
import { describeCommand, describeFacts } from "./node-details.js";
import type { GraphNode } from "./run-graph.js";
import { type Body, type LogEntry, type OutputBlock, buildStepLog } from "./step-log.js";
import { type StepLogFeed, useStepLog } from "./use-step-log.js";

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
  openCommandId?: string;
  onOpenCommand(id: string | undefined): void;
  onClose(): void;
}

export function StepLogPanel({ runId, node, now, live, upTo, openCommandId, onOpenCommand, onClose }: StepLogPanelProps) {
  const feed = useStepLog(runId, node.id, live);
  const log = useMemo(() => buildStepLog(feed.items, { upTo }), [feed.items, upTo]);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(live); // a step that is still going is followed at its tail; a finished one is read from its start

  // Follow the tail: after new content, go to the bottom, unless the reader scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [log.count]);

  // Over the canvas (a narrow screen), the log takes the focus; when it closes, the node gets it back.
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (panel.current && closeButton.current) focusOnOpen(panel.current, closeButton.current, (el) => getComputedStyle(el));
    // A passive cleanup runs once the panel is out of the page and the canvas is shown again, so the node can take the focus.
    return () => focusOnClose(document, node.id);
    // Once, on purpose: the focus goes into the panel when it opens and back to the node when it closes. RunView keys the panel by
    // the node's id (`key={selected.id}`), so another node is another mount, and the `node.id` the cleanup closed over is its node's.
  }, []);

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
    <aside className="step-panel" ref={panel} aria-label={`Log of ${node.label}`}>
      <header>
        <h2 title={node.label}>{node.label}</h2>
        <span className={`tail${live ? " live" : ""}`}>{live ? "tailing" : upTo !== undefined ? "replay" : ""}</span>
        <button type="button" className="btn close" ref={closeButton} onClick={onClose} aria-label="Close the log">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <NodeRows rows={rows} className="facts" />
      <CommandList commands={node.commands} openId={openCommandId} onSelect={onOpenCommand} />
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

export interface CommandListProps {
  commands: GraphNode[];
  openId?: string;
  onSelect(id: string | undefined): void;
}

export function CommandList({ commands, openId, onSelect }: CommandListProps) {
  if (commands.length === 0) return null;
  return (
    <section className="commands" aria-label="Commands">
      <h3>
        Commands <span className="count">{formatCount(commands.length)}</span>
      </h3>
      <ul>
        {commands.map((command) => {
          const open = command.id === openId;
          return (
            <li key={command.id}>
              <button
                type="button"
                className={`command-item state-${command.state}`}
                data-command-id={command.id}
                aria-pressed={open}
                aria-label={`${command.label}: ${command.state}. Open its output`}
                title={command.label}
                onClick={() => onSelect(open ? undefined : command.id)}
              >
                <Glyph state={command.state} />
                <span className="label">{command.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const OWN_ESCAPE = new Set(["INPUT", "SELECT", "TEXTAREA"]);

export function closesOnEscape(event: { key: string; defaultPrevented: boolean; target: unknown }): boolean {
  const tag = (event.target as { tagName?: string } | null)?.tagName;
  return event.key === "Escape" && !event.defaultPrevented && !OWN_ESCAPE.has(tag ?? "");
}

function useEscape(onClose: () => void, capture: boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!closesOnEscape(event)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [onClose, capture]);
}

function useFocusInto(selectorToRestore: string) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (panel.current && closeButton.current) focusOnOpen(panel.current, closeButton.current, (el) => getComputedStyle(el));
    return () => restoreFocus(document, selectorToRestore);
  }, []);
  return { panel, closeButton };
}

export interface PhasePanelProps {
  lane: number;
  title: string;
  commands: GraphNode[];
  openId?: string;
  onSelect(id: string | undefined): void;
  onClose(): void;
}

export function PhasePanel({ lane, title, commands, openId, onSelect, onClose }: PhasePanelProps) {
  const { panel, closeButton } = useFocusInto(phaseEntrySelector(lane));
  useEscape(onClose, false);
  const name = title === "" ? "the run" : title;
  return (
    <aside className="step-panel phase-panel" ref={panel} aria-label={`Workflow commands of ${name}`}>
      <header>
        <h2 title={name}>
          {title === "" ? "Run" : title} <span className="kind">workflow</span>
        </h2>
        <button type="button" className="btn close" ref={closeButton} onClick={onClose} aria-label="Close the list">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="log" tabIndex={0} aria-label="Workflow commands">
        {commands.length === 0 ? <p className="notice">No command ran outside a step.</p> : <CommandList commands={commands} openId={openId} onSelect={onSelect} />}
      </div>
    </aside>
  );
}

export interface CommandDetailsProps {
  command: GraphNode;
  feed: StepLogFeed;
  now: number;
  live: boolean;
  upTo?: number;
}

export function CommandDetails({ command, feed, now, live, upTo }: CommandDetailsProps) {
  const log = useMemo(() => buildStepLog(feed.items, { upTo }), [feed.items, upTo]);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(live);
  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [log.count]);

  let body: ReactNode;
  if (feed.status === "loading") body = <p className="notice">Reading the command…</p>;
  else if (feed.status === "error") {
    body = (
      <p className="notice" role="alert">
        The output of this command could not be read: {feed.error}
      </p>
    );
  } else if (log.attempts.length === 0) {
    body = <p className="notice">{live ? "Waiting for the command to write something…" : upTo !== undefined && feed.items.length > 0 ? "Nothing of this command is written at this point of the replay." : "This command wrote no output."}</p>;
  } else {
    body = log.attempts.map((attempt) => (
      <div key={attempt.attemptId} className="attempt">
        {log.attempts.length > 1 && <h2>Attempt {attempt.number}</h2>}
        {attempt.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} reprompt={false} />
        ))}
      </div>
    ));
  }
  return (
    <>
      <NodeRows rows={describeCommand(command, now)} className="facts" />
      <div
        className="log"
        ref={scroller}
        role="log"
        aria-live="off"
        tabIndex={0}
        aria-label="Command output"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
        }}
      >
        {body}
      </div>
    </>
  );
}

export interface CommandPanelProps {
  runId: string;
  command: GraphNode;
  now: number;
  live: boolean;
  upTo?: number;
  onClose(): void;
}

export function CommandPanel({ runId, command, now, live, upTo, onClose }: CommandPanelProps) {
  const feed = useStepLog(runId, command.id, live);
  const { panel, closeButton } = useFocusInto(commandItemSelector(command.id));
  useEscape(onClose, true);
  return (
    <section className="command-panel" role="dialog" aria-label={`Command ${command.label}`} ref={panel}>
      <header>
        <h2 title={command.label}>{command.label}</h2>
        <span className={`tail${live ? " live" : ""}`}>{live ? "running" : upTo !== undefined ? "replay" : ""}</span>
        <button type="button" className="btn close" ref={closeButton} onClick={onClose} aria-label="Close the command">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <CommandDetails command={command} feed={feed} now={now} live={live} upTo={upTo} />
    </section>
  );
}
