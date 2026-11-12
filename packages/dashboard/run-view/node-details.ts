// What hovering a node says, as rows of text. Pure: the caller gives it the clock.
import { formatCents, formatDuration } from "../app/format.js";
import { type GraphNode, isWork } from "./run-graph.js";

const tokens = new Intl.NumberFormat("en-US");

/** The rows of the tooltip of a step or command, as `[label, value]`; none for the start, a fork or a join. `now` is the time in ms, to time a node that is still running. */
export function describeNode(node: GraphNode, now: number): Array<[string, string]> {
  if (!isWork(node.kind)) return [];
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
