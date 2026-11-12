// What hovering a node says, as rows of text. Pure: the caller gives it the clock.
import { formatCents, formatDuration } from "../app/format.js";
import { type GraphNode, isWork } from "./run-graph.js";

const tokens = new Intl.NumberFormat("en-US");

/** One line of a node's details. `href` makes the value a link. */
export interface NodeRow {
  name: string;
  value: string;
  href?: string;
}

/** What a cloud agent's id looks like (`bc-` and the id Cursor gave it): the only shape the dashboard turns into a link. */
const CLOUD_AGENT_ID = /^bc-[A-Za-z0-9-]+$/;

/** Where Cursor shows a cloud agent, or undefined when `agentId` is not shaped like one (an event log is data, not a source of addresses). */
export const cloudAgentUrl = (agentId: string): string | undefined => (CLOUD_AGENT_ID.test(agentId) ? `https://cursor.com/agents/${agentId}` : undefined);

/** Whether the node is a step that ran as a Cursor cloud agent: what gets the cloud badge and the cloud facts. */
export const runsInCloud = (node: GraphNode): boolean => isWork(node.kind) && node.detail.location === "cloud";

/** The rows of a node's details (its tooltip; `describeFacts` picks the ones above a step's log); none for the start, a fork or a join. `now` is the time in ms, to time a node that is still running. */
export function describeNode(node: GraphNode, now: number): NodeRow[] {
  if (!isWork(node.kind)) return [];
  const d = node.detail;
  const elapsed = node.state === "running" && d.runningSince !== undefined ? Math.max(0, now - Date.parse(d.runningSince)) : 0;
  const rows: NodeRow[] = [{ name: "State", value: node.state }];
  if (node.kind === "step" && d.model !== undefined) rows.push({ name: "Model", value: d.model });
  if (node.kind === "command" && d.command !== undefined) rows.push({ name: "Command", value: d.command });
  rows.push({ name: "Location", value: d.location });
  if (d.cloudAgentId !== undefined) {
    const href = cloudAgentUrl(d.cloudAgentId);
    rows.push({ name: "Cloud agent", value: d.cloudAgentId, ...(href !== undefined && { href }) });
  }
  rows.push({ name: "Attempts", value: d.cached && d.attempts === 0 ? `0 (from the ${d.cached === "memo" ? "memo" : "journal"})` : String(d.attempts) });
  if (node.kind === "step") {
    rows.push({ name: "Tokens", value: tokens.format(d.tokens) });
    rows.push({ name: "Cost", value: `${formatCents(d.costCents)}${d.costFinal ? "" : " (not final)"}` });
  }
  rows.push({ name: "Duration", value: formatDuration(d.durationMs + elapsed) });
  if (d.errorKind !== undefined) rows.push({ name: "Error kind", value: d.errorKind });
  if (d.error !== undefined) rows.push({ name: "Error", value: d.error.length > 300 ? `${d.error.slice(0, 299)}…` : d.error });
  return rows;
}

/** The rows that head a step's log: the short list, and for a step that ran in the cloud also where it ran, its agent and its cost. */
const FACTS = ["State", "Model", "Command", "Attempts", "Duration"];
const CLOUD_FACTS = ["Location", "Cloud agent", "Cost"];
export function describeFacts(node: GraphNode, now: number): NodeRow[] {
  const shown = runsInCloud(node) ? [...FACTS, ...CLOUD_FACTS] : FACTS;
  return describeNode(node, now).filter((row) => shown.includes(row.name));
}
