// What hovering a node says, as rows of text. Pure: the caller gives it the clock.
import type { GraphNode } from "./run-graph.js";

/** `0.4¢`, `3.5¢`, `$12.35`: a cost under a dollar stays in cents. */
export function formatCents(cents: number): string {
  return cents < 100 ? `${Number(cents.toFixed(2))}¢` : `$${(Math.round(cents) / 100).toFixed(2)}`;
}

/** `7ms`, `4.2s`, `1m 9s`, `1h 2m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (ms < 3_600_000) return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const tokens = new Intl.NumberFormat("en-US");

/** The rows of the tooltip of a step or command, as `[label, value]`; none for the start, a fork or a join. `now` is the time in ms, to time a node that is still running. */
export function describeNode(node: GraphNode, now: number): Array<[string, string]> {
  if (node.kind !== "step" && node.kind !== "command") return [];
  const d = node.detail;
  const elapsed = node.state === "running" && d.runningSince !== undefined ? Math.max(0, now - Date.parse(d.runningSince)) : 0;
  const rows: Array<[string, string]> = [["State", node.state]];
  if (node.kind === "step" && d.model !== undefined) rows.push(["Model", d.model]);
  if (node.kind === "command" && d.command !== undefined) rows.push(["Command", d.command]);
  rows.push(["Location", d.location]);
  rows.push(["Attempts", d.cached && d.attempts === 0 ? `0 (from the ${d.cached === "memo" ? "memo" : "journal"})` : String(d.attempts)]);
  if (node.kind === "step") {
    rows.push(["Tokens", tokens.format(d.tokens)]);
    rows.push(["Cost", `${formatCents(d.costCents)}${d.costFinal ? "" : " (not final)"}`]);
  }
  rows.push(["Duration", formatDuration(d.durationMs + elapsed)]);
  if (d.errorKind !== undefined) rows.push(["Error kind", d.errorKind]);
  if (d.error !== undefined) rows.push(["Error", d.error.length > 300 ? `${d.error.slice(0, 299)}…` : d.error]);
  return rows;
}
