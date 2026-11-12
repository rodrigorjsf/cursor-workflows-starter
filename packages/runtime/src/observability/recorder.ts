// Grava os eventos do runtime no banco de métricas.
//
// Regras:
//  - Só insere (tentativas, turnos, usage_runs, métricas); `runs` recebe o fechamento no fim. Um resume do mesmo
//    run_id é uma nova execução (exec_id), então somar as tentativas nunca conta duas vezes.
//  - Hits de journal/memo viram tentativas de custo zero com `cached`, para a view de economia.
//  - No content: prompts only as a hash and a size. Prompt text, agent messages, tool calls and command output live in
//    the run's local event log (`content` events) and never reach this recorder.

import { randomUUID } from "node:crypto";
import type { WorkflowEvent } from "../runtime/events.js";
import { outcomeClass } from "../runtime/outcome.js";
import { type Db, openDb, write } from "./db.js";

const now = () => new Date().toISOString();
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export interface Recorder {
  record(e: WorkflowEvent): void;
  close(): void;
}

export async function createRecorder(path?: string): Promise<Recorder> {
  const db: Db = await openDb(path);
  const execId = randomUUID();
  const starts = new Map<string, Extract<WorkflowEvent, { type: "step-start" }> & { at: string }>();

  const insRun = db.prepare(
    `INSERT INTO runs (exec_id, run_id, workflow, workflow_hash, args_hash, repo_name, repo_hash, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const endRun = db.prepare(
    `UPDATE runs SET finished_at = ?, status = ?, outcome_status = ?, outcome_class = ?, error = ? WHERE exec_id = ?`,
  );
  const insAttempt = db.prepare(
    `INSERT INTO attempts (attempt_id, exec_id, step_key, label, phase, attempt, cached, model_id, model_key, model_params,
       setting_sources, tools, prompt_hash, prompt_chars, ok, error_kind, schema_reprompts, turns, steps,
       tool_calls, summaries, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
       raw_cents, charged_cents, cost_final, agent_id, started_at, duration_ms, resolved_model_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insTurn = db.prepare(
    `INSERT OR REPLACE INTO turns (attempt_id, idx, steps, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insUsageRun = db.prepare(
    `INSERT OR REPLACE INTO usage_runs (attempt_id, usage_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, raw_cents, charged_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insMetric = db.prepare(`INSERT INTO metrics (exec_id, name, value_num, value_text, at) VALUES (?, ?, ?, ?, ?)`);

  // Turnos chegam antes do step-end (que cria a linha da tentativa): ficam em memória até lá.
  const pendingTurns = new Map<string, Array<Extract<WorkflowEvent, { type: "turn" }>>>();

  return {
    record(e) {
      switch (e.type) {
        case "run-start":
          write(db, () => insRun.run(execId, e.runId, e.workflow, e.workflowHash, e.argsHash, e.repo.name, e.repo.hash, now()));
          break;
        case "step-start":
          starts.set(e.attemptId, { ...e, at: now() });
          break;
        case "turn": {
          const list = pendingTurns.get(e.attemptId) ?? [];
          list.push(e);
          pendingTurns.set(e.attemptId, list);
          break;
        }
        case "step-end": {
          const s = starts.get(e.attemptId);
          starts.delete(e.attemptId);
          const turns = pendingTurns.get(e.attemptId) ?? [];
          pendingTurns.delete(e.attemptId);
          const u = e.usage;
          write(db, () => {
            insAttempt.run(
              e.attemptId, execId, e.stepKey, e.label, e.phase ?? null, e.attempt ?? 1, e.cached || null,
              e.model ?? null, e.modelKey ?? null, json(s?.modelParams), json(s?.settingSources), json(s?.tools),
              s?.promptHash ?? null, s?.promptChars ?? null,
              e.ok ? 1 : 0, e.errorKind ?? null, e.schemaReprompts ?? 0, e.turns ?? 0, e.steps ?? 0,
              json(e.toolCalls), e.summaries ?? 0,
              u?.inputTokens ?? 0, u?.outputTokens ?? 0, u?.cacheReadTokens ?? 0, u?.cacheWriteTokens ?? 0, e.reasoningTokens ?? 0,
              e.rawCents ?? null, e.chargedCents, e.cached ? 1 : e.costFinal ? 1 : 0, e.agentId ?? null,
              s?.at ?? now(), e.durationMs ?? 0, e.resolvedModel ?? null,
            );
            for (const t of turns) {
              insTurn.run(e.attemptId, t.idx, t.steps, t.usage.inputTokens, t.usage.outputTokens, t.usage.cacheReadTokens, t.usage.cacheWriteTokens, t.usage.reasoningTokens ?? 0);
            }
            for (const r of e.usageRuns ?? []) {
              insUsageRun.run(e.attemptId, r.runId, r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, r.usage.cacheWriteTokens, r.cost?.rawCostCents ?? null, r.cost?.chargedCents ?? null);
            }
          });
          break;
        }
        case "metric":
          write(db, () =>
            insMetric.run(execId, e.name, typeof e.value === "number" ? e.value : null, typeof e.value === "string" ? e.value : null, now()),
          );
          break;
        case "run-end":
          write(db, () => endRun.run(now(), e.status, e.outcomeStatus ?? null, outcomeClass(e.status, e.outcomeStatus), e.error ?? null, execId));
          break;
      }
    },
    close() {
      db.close();
    },
  };
}
