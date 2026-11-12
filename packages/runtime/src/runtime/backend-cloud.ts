// The cloud backend: one attempt of a step on a Cursor cloud agent (ADR-0005). A cloud agent is not a local agent somewhere
// else: it rejects custom tools and tool allowlists, ignores setting sources, and sees only what was pushed to a remote. So
// before the agent is created the worktree is pushed as a snapshot branch (cloud-snapshot.ts) and the agent starts from it;
// when the attempt ends the branch is deleted. The backend never sends custom tools, allowlists or setting sources, and
// asks for a structured result as a final fenced JSON block in the answer, which it validates and, when it is wrong,
// corrects with follow-ups in the same conversation.
//
// It runs read-only steps. A step that writes needs the agent's commits brought back, which is not here yet.

import { Agent } from "@cursor/sdk";
import { type AgentBackend, type AttemptEvent, type AttemptResult, type Delivery, type StepOptions, converse, runAttempt } from "./backend.js";
import { deleteSnapshot, cloudRepoUrl, pushSnapshot, snapshotBranch } from "./cloud-snapshot.js";
import { jsonBlockInstruction, jsonBlockReprompt, resultFromJsonBlock } from "./structured.js";

/** What a read-only cloud step is told, since the allowlist that would make it so cannot be sent. */
const READ_ONLY_INSTRUCTION = "\n\n---\nThis is a read-only step: do not create, edit or delete files, do not commit, and do not push or open a pull request.";

export interface CloudBackendOptions {
  /** The git remote the snapshots go to (the `cloud.remote` preference). */
  remote: string;
  /** The run the steps belong to: part of every snapshot branch's name. */
  runId: string;
}

async function runCloudAttempt({ remote, runId }: CloudBackendOptions, prompt: string, o: StepOptions, signal: AbortSignal, onEvent: (event: AttemptEvent) => void): Promise<AttemptResult> {
  onEvent({
    type: "warning",
    message: `cloud agents ignore setting sources (requested: ${o.settingSources.join(", ") || "none"}): the VM loads the project, team and plugin settings it always loads`,
  });
  let snapshot;
  try {
    snapshot = await pushSnapshot({ cwd: o.cwd, remote, branch: snapshotBranch(runId), signal });
  } catch (err) {
    return { outcome: signal.aborted ? { kind: "aborted", reason: signal.reason } : { kind: "error", reason: "other", message: `cloud snapshot: ${err instanceof Error ? err.message : String(err)}` } };
  }
  try {
    const { schema } = o;
    const check = (answer: { result?: string }): Delivery => {
      const delivered = resultFromJsonBlock(answer.result ?? "", schema!);
      return delivered.ok ? delivered : { ok: false, message: `the agent did not end with a valid JSON block (${delivered.error})`, reprompt: jsonBlockReprompt(delivered.error) };
    };
    const message = prompt + (o.writes ? "" : READ_ONLY_INSTRUCTION) + (schema ? jsonBlockInstruction(schema) : "");
    return await runAttempt(
      signal,
      onEvent,
      () =>
        // Never `tools`, `disallowedTools`, `systemPrompt` or `local` (custom tools, setting sources): a cloud agent rejects or ignores them.
        Agent.create({
          apiKey: o.apiKey,
          name: o.name,
          model: o.model,
          agents: o.agents,
          mcpServers: o.mcpServers,
          cloud: { repos: [{ url: cloudRepoUrl(snapshot.remoteUrl), startingRef: snapshot.branch }], autoCreatePR: false },
        }),
      (exchange) => converse(exchange, message, { schemaRetries: o.schemaRetries, check: schema ? check : undefined, onEvent }),
    );
  } finally {
    await deleteSnapshot(snapshot).catch((err: unknown) =>
      onEvent({ type: "warning", message: `could not delete the snapshot branch ${snapshot.branch} from ${remote} (${err instanceof Error ? err.message : String(err)}): delete it by hand` }),
    );
  }
}

/** The cloud backend of one run. */
export function createCloudBackend(options: CloudBackendOptions): AgentBackend {
  return { location: "cloud", run: (prompt, o, signal, onEvent) => runCloudAttempt(options, prompt, o, signal, onEvent) };
}
