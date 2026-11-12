// Consultas de análise usadas por `wf stats`, pelo dashboard e pelo export.
// Todas aceitam uma janela em dias. As views do schema servem para uso direto com o sqlite3.

import { type Db, write } from "./db.js";

type Row = Record<string, unknown>;
const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export function summary(db: Db, days = 30): Record<string, Row[]> {
  const s = since(days);
  // Um `?` por uso da data de corte. Parâmetros numerados (`?1`) não funcionam no node:sqlite do Node 22.13 a 22.19.
  const q = (sql: string) => db.prepare(sql).all(...Array<string>((sql.match(/\?/g) ?? []).length).fill(s)) as Row[];
  return {
    // `runs` vem de v_runs, como `workflows[].runs`: um run que só roda comandos não tem tentativa e conta mesmo assim.
    totals: q(`
      SELECT (SELECT COUNT(*) FROM v_runs WHERE started_at >= ?) AS runs, ROUND(SUM(cost_cents), 2) AS cost_cents,
             SUM(prompt_tokens + output_tokens) AS tokens,
             SUM(cached IS NOT NULL) AS cached_steps, SUM(ok = 0) AS failed_attempts,
             ROUND(1.0 * SUM(cache_read_tokens) / NULLIF(SUM(prompt_tokens), 0), 3) AS cache_share,
             SUM(cost_final = 0 AND cached IS NULL) AS unreconciled
      FROM v_attempts WHERE started_at >= ?`),
    workflows: q(`
      SELECT workflow, COUNT(*) AS runs, SUM(outcome_class = 'delivered') AS delivered,
             ROUND(1.0 * SUM(outcome_class = 'delivered') / COUNT(*), 3) AS delivery_rate,
             ROUND(SUM(cost_cents), 2) AS cost_cents,
             ROUND(SUM(cost_cents) / NULLIF(SUM(outcome_class = 'delivered'), 0), 2) AS cost_per_delivery_cents,
             SUM(human_verdict = 'rejected') AS human_rejected
      FROM v_runs WHERE started_at >= ? GROUP BY workflow ORDER BY cost_cents DESC`),
    models: q(`
      SELECT model_key, COUNT(*) AS attempts, ROUND(AVG(ok), 3) AS ok_rate, ROUND(SUM(cost_cents), 2) AS cost_cents,
             ROUND(SUM(cost_cents) / NULLIF(SUM(ok), 0), 3) AS cost_per_ok_cents,
             ROUND(1.0 * SUM(cache_read_tokens) / NULLIF(SUM(prompt_tokens), 0), 3) AS cache_share,
             ROUND(AVG(steps), 1) AS avg_steps, ROUND(AVG(schema_reprompts), 2) AS avg_reprompts,
             ROUND(MAX(avg_prompt_per_step)) AS max_ctx_per_step, SUM(summaries) AS summaries
      FROM v_attempts WHERE cached IS NULL AND started_at >= ? GROUP BY model_key ORDER BY cost_cents DESC`),
    contextBuckets: q(`
      SELECT model_key, ctx_bucket_k, COUNT(*) AS attempts, ROUND(AVG(ok), 3) AS ok_rate, ROUND(AVG(steps), 1) AS avg_steps,
             ROUND(SUM(cost_cents) * 1000.0 / NULLIF(SUM(prompt_tokens + output_tokens), 0), 4) AS cents_per_1k_tokens,
             ROUND(AVG(cost_cents), 3) AS avg_cost_cents, SUM(summaries) AS summaries
      FROM v_attempts WHERE cached IS NULL AND cost_source = 'cursor' AND started_at >= ?
      GROUP BY model_key, ctx_bucket_k ORDER BY model_key, ctx_bucket_k`),
    daily: q(`
      SELECT substr(started_at, 1, 10) AS day, workflow, ROUND(SUM(cost_cents), 2) AS cost_cents,
             SUM(prompt_tokens + output_tokens) AS tokens
      FROM v_attempts WHERE cached IS NULL AND started_at >= ? GROUP BY day, workflow ORDER BY day`),
    waste: q(`
      SELECT workflow, label, error_kind, COUNT(*) AS failed_attempts, ROUND(SUM(cost_cents), 2) AS cost_cents
      FROM v_attempts WHERE ok = 0 AND started_at >= ? GROUP BY workflow, label, error_kind ORDER BY cost_cents DESC LIMIT 20`),
    savings: q(`
      SELECT c.workflow, c.cached, COUNT(*) AS hits,
             ROUND(SUM(COALESCE((SELECT AVG(x.cost_cents) FROM v_attempts x
                                 WHERE x.step_key = c.step_key AND x.cached IS NULL AND x.ok = 1), 0)), 2) AS est_saved_cents
      FROM v_attempts c WHERE c.cached IS NOT NULL AND c.started_at >= ? GROUP BY c.workflow, c.cached`),
    attribution: q(`
      SELECT ROUND(SUM(a.raw_cents), 2) AS attempts_raw_cents,
             ROUND((SELECT SUM(u.raw_cents) FROM usage_runs u JOIN attempts a2 ON a2.attempt_id = u.attempt_id WHERE a2.started_at >= ?), 2) AS usage_runs_raw_cents
      FROM attempts a WHERE a.cached IS NULL AND a.started_at >= ?`),
  };
}

/** Export para consolidar fora (BI, planilha, time). Anonimizado por padrão. */
export function exportRows(db: Db, days: number, anonymize = true): Record<string, Row[]> {
  const s = since(days);
  const runs = db.prepare(`SELECT * FROM runs WHERE started_at >= ?`).all(s) as Row[];
  const attempts = db.prepare(`SELECT * FROM v_attempts WHERE started_at >= ?`).all(s) as Row[];
  const metrics = db.prepare(`SELECT m.* FROM metrics m JOIN runs r ON r.exec_id = m.exec_id WHERE r.started_at >= ?`).all(s) as Row[];
  if (anonymize) {
    for (const r of runs) {
      r.repo_name = null;
      r.error = r.error ? "[redacted]" : null;
    }
    for (const a of attempts) {
      a.prompt_text = null;
      a.agent_id = null;
      a.repo_name = null;
    }
  }
  return { runs, attempts, metrics };
}

export function toCsv(rows: Row[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/**
 * Completa custos que o Cursor ainda não tinha reportado ao fim da etapa ("eventually consistent").
 * Usa `Agent.getUsage(agentId)` estático. Para agentes locais já descartados isso pode não funcionar: o
 * resultado conta quantos foram atualizados e quantos falharam.
 */
export async function reconcile(db: Db, opts: { apiKey?: string } = {}): Promise<{ updated: number; failed: number }> {
  // Loaded here, not at the top of the module: `summary` is also the dashboard's, a process that stays up and has no use for the SDK (hundreds of MB).
  const { Agent } = await import("@cursor/sdk");
  const rows = db.prepare(`SELECT attempt_id, agent_id FROM v_unreconciled`).all() as Array<{ attempt_id: string; agent_id: string }>;
  const upd = db.prepare(
    `UPDATE attempts SET raw_cents = ?, charged_cents = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
       cache_write_tokens = ?, cost_final = 1 WHERE attempt_id = ?`,
  );
  let updated = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const u = await Agent.getUsage(r.agent_id, { apiKey: opts.apiKey });
      if (!u.cost) {
        failed++;
        continue;
      }
      write(db, () =>
        upd.run(u.cost!.rawCostCents, u.cost!.chargedCents, u.usage.inputTokens, u.usage.outputTokens, u.usage.cacheReadTokens, u.usage.cacheWriteTokens, r.attempt_id),
      );
      updated++;
    } catch {
      failed++;
    }
  }
  return { updated, failed };
}

/** Veredito humano sobre a entrega (ex.: PR aceito/rejeitado). Vale para todas as execuções do run. */
export function markRun(db: Db, runId: string, verdict: "accepted" | "rejected"): number {
  return Number(write(db, () => db.prepare(`UPDATE runs SET human_verdict = ? WHERE run_id = ?`).run(verdict, runId)).changes);
}
