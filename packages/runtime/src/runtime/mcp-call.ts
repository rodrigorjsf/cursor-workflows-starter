// SPDX-License-Identifier: MIT
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readKitPackage } from "../kit-version.js";
import { errorText } from "./error-text.js";
import type { ExecOutcome } from "./events.js";
import { isSecretName } from "./redaction.js";
import type { McpResult, McpStdioServer } from "./workflow.js";

export const MCP_CALL_TIMEOUT_MS = 600_000;

const STDERR_TAIL_CHARS = 2_000;

export interface McpCallSpec {
  server: McpStdioServer;
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface McpCallOutcome {
  outcome: ExecOutcome;
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
  error?: string;
}

const liveTransports = new Set<StdioClientTransport>();
let exitHookInstalled = false;

function killLiveServers(): void {
  for (const transport of liveTransports) {
    if (transport.pid === null) continue;
    try {
      process.kill(transport.pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}

export function textOf(content: readonly unknown[]): string {
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") texts.push(text);
  }
  return texts.join("\n");
}

export function secretValuesOf(value: unknown, named = false): string[] {
  if (typeof value === "string") return named ? [value] : [];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => secretValuesOf(item, named || isSecretName(key)));
}

export function toMcpResult(outcome: McpCallOutcome): McpResult {
  return {
    ok: outcome.outcome === "exit" && !outcome.isError,
    text: textOf(outcome.content),
    content: outcome.content,
    ...(outcome.structuredContent === undefined ? {} : { structuredContent: outcome.structuredContent }),
    timedOut: outcome.outcome === "timeout",
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

export async function callMcpTool(spec: McpCallSpec): Promise<McpCallOutcome> {
  if (spec.signal?.aborted) return { outcome: "cancelled", isError: true, content: [] };
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killLiveServers);
  }
  const transport = new StdioClientTransport({ command: spec.server.command, args: spec.server.args, env: spec.server.env, cwd: spec.cwd, stderr: "pipe" });
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS)));
  const client = new Client({ name: "cursor-workflows", version: readKitPackage().version });
  const stop = new AbortController();
  let stoppedFor: "timeout" | "cancelled" | undefined;
  const stopFor = (why: "timeout" | "cancelled") => {
    stoppedFor ??= why;
    stop.abort();
  };
  const timer = setTimeout(() => stopFor("timeout"), spec.timeoutMs);
  const onAbort = () => stopFor("cancelled");
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  const failed = (outcome: ExecOutcome, err: unknown): McpCallOutcome => {
    const printed = stderrTail.trim();
    return { outcome: stoppedFor ?? outcome, isError: true, content: [], error: `${errorText(err)}${printed ? `; the server wrote on stderr: ${printed}` : ""}` };
  };
  liveTransports.add(transport);
  try {
    try {
      await client.connect(transport, { signal: stop.signal, timeout: spec.timeoutMs });
    } catch (err) {
      return failed("spawn-error", err);
    }
    try {
      const reply = await client.callTool({ name: spec.tool, arguments: spec.args }, undefined, { signal: stop.signal, timeout: spec.timeoutMs });
      const content: unknown[] = Array.isArray(reply.content) ? reply.content : [];
      const isError = reply.isError === true;
      return {
        outcome: "exit",
        isError,
        content,
        ...(reply.structuredContent === undefined ? {} : { structuredContent: reply.structuredContent }),
        ...(isError ? { error: textOf(content) || "the tool reported an error" } : {}),
      };
    } catch (err) {
      return failed("exit", err);
    }
  } finally {
    clearTimeout(timer);
    spec.signal?.removeEventListener("abort", onAbort);
    await client.close().catch(() => undefined);
    liveTransports.delete(transport);
  }
}
