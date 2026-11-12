// Schema do banco de métricas (SQLite). Migração por `PRAGMA user_version`.
//
// Unidades: tokens inteiros; custos em centavos de dólar (float), como o SDK (`UsageCost`).
// Datas: ISO-8601 UTC (texto), comparáveis com `datetime('now', '-30 days')`.
//
// O que cada número significa (ver docs/09-observabilidade.md):
//  - `raw_cents`: custo bruto calculado pelo Cursor (sem descontos), quando `getUsage()` responde. Em contas onde
//    ele devolve 403 feature_unavailable (agentes locais) fica NULL, e as views usam a estimativa da tabela `pricing`.
//  - `charged_cents`: o que foi cobrado. É 0 para uso incluído no plano, BYOK e créditos.
//  - `prompt_tokens` = input_tokens: medido na API, o input já inclui leitura e escrita de cache (total = input +
//    output). É o volume de prompt da tentativa, somando todas as chamadas ao modelo; não é a ocupação da janela.
//  - `avg_prompt_per_step` = prompt_tokens / passos (`step-completed`). Um passo pode agrupar várias chamadas ao
//    modelo e várias tools (medido: 4 leituras e 2 chamadas num único passo), então isto superestima o contexto
//    por chamada. É só um indicador grosseiro de faixa.

/** View base de tentativas. `modelExpr` é o ID usado para achar o preço de referência (a migração 2 usa o resolvido). */
function vAttempts(modelExpr: string): string {
  return `CREATE VIEW v_attempts AS
SELECT a.*, r.workflow, r.run_id, r.repo_name, r.workflow_hash, r.outcome_class,
       a.input_tokens AS prompt_tokens,
       CAST(a.input_tokens AS REAL) / MAX(a.steps, 1) AS avg_prompt_per_step,
       CAST((a.input_tokens / MAX(a.steps, 1)) / 25000 AS INTEGER) * 25 AS ctx_bucket_k,
       CASE WHEN a.raw_cents IS NOT NULL AND a.raw_cents > 0 THEN 'cursor'
            WHEN p.pattern IS NOT NULL AND a.cached IS NULL THEN 'estimate' ELSE 'none' END AS cost_source,
       CASE WHEN a.raw_cents IS NOT NULL AND a.raw_cents > 0 THEN a.raw_cents
            WHEN p.pattern IS NOT NULL AND a.cached IS NULL THEN (
              MAX(a.input_tokens - a.cache_read_tokens - a.cache_write_tokens, 0) * (CASE WHEN p.tier_threshold IS NOT NULL
                                       AND a.input_tokens / MAX(a.steps, 1) > p.tier_threshold
                                     THEN p.input_above_per_m ELSE p.input_per_m END)
              + a.output_tokens * (CASE WHEN p.tier_threshold IS NOT NULL
                                       AND a.input_tokens / MAX(a.steps, 1) > p.tier_threshold
                                     THEN p.output_above_per_m ELSE p.output_per_m END)
              + a.cache_read_tokens * COALESCE(p.cache_read_per_m, p.input_per_m)
              + a.cache_write_tokens * COALESCE(p.cache_write_per_m, p.input_per_m)
            ) / 1e6 * 100
            ELSE 0 END AS cost_cents
FROM attempts a
JOIN runs r ON r.exec_id = a.exec_id
LEFT JOIN pricing p ON p.rowid = (
  SELECT rowid FROM pricing WHERE ${modelExpr} GLOB pricing.pattern AND pricing.effective_from <= a.started_at
  ORDER BY effective_from DESC LIMIT 1);
`;
}

export const SCHEMA_VERSION = 3;

export const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE runs (
  exec_id        TEXT PRIMARY KEY,          -- uma execução de processo (um resume gera outra exec do mesmo run_id)
  run_id         TEXT NOT NULL,
  workflow       TEXT NOT NULL,
  workflow_hash  TEXT NOT NULL,             -- versão do código do workflow (compare só versões iguais)
  args_hash      TEXT,
  repo_name      TEXT,
  repo_hash      TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  status         TEXT,                      -- finished | failed | cancelled (do runtime)
  outcome_status TEXT,                      -- result.status devolvido pelo workflow (ex.: done, tests-failed)
  outcome_class  TEXT,                      -- delivered | failed | error | cancelled | unknown
  human_verdict  TEXT,                      -- accepted | rejected (wf metrics mark)
  error          TEXT
);
CREATE INDEX runs_workflow ON runs(workflow, started_at);
CREATE INDEX runs_run_id ON runs(run_id);

CREATE TABLE attempts (
  attempt_id        TEXT PRIMARY KEY,
  exec_id           TEXT NOT NULL REFERENCES runs(exec_id),
  step_key          TEXT NOT NULL,          -- chave do journal (mesma etapa entre runs/resumes)
  label             TEXT,
  phase             TEXT,
  attempt           INTEGER NOT NULL,
  cached            TEXT,                   -- NULL | journal | memo (sem chamada à API)
  model_id          TEXT,
  model_key         TEXT,                   -- id + params ordenados (esforço etc. são "braços" distintos)
  model_params      TEXT,                   -- JSON
  setting_sources   TEXT,                   -- JSON
  tools             TEXT,                   -- JSON (allowlist) ou NULL = padrão
  prompt_hash       TEXT,
  prompt_chars      INTEGER,
  prompt_text       TEXT,                   -- legado: nunca mais gravado (o texto dos prompts fica só no log de eventos local)
  ok                INTEGER NOT NULL,
  error_kind        TEXT,                   -- timeout | run-error | schema | rate-limit | cancelled | exception
  schema_reprompts  INTEGER DEFAULT 0,
  turns             INTEGER DEFAULT 0,
  steps             INTEGER DEFAULT 0,      -- passos (step-completed) no stream; um passo pode agrupar várias chamadas ao modelo
  tool_calls        TEXT,                   -- JSON {"shell": 3, "read": 7}
  summaries         INTEGER DEFAULT 0,      -- compactações de contexto (sinal de pressão de janela)
  input_tokens      INTEGER DEFAULT 0,
  output_tokens     INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens  INTEGER DEFAULT 0,
  raw_cents         REAL,
  charged_cents     REAL,
  cost_final        INTEGER DEFAULT 0,      -- 0 = custo ausente/parcial; wf metrics reconcile completa
  agent_id          TEXT,
  started_at        TEXT,
  duration_ms       INTEGER
);
CREATE INDEX attempts_exec ON attempts(exec_id);
CREATE INDEX attempts_model ON attempts(model_key);
CREATE INDEX attempts_step ON attempts(step_key);

CREATE TABLE turns (
  attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id),
  idx               INTEGER NOT NULL,
  steps             INTEGER,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens  INTEGER,
  PRIMARY KEY (attempt_id, idx)
);

-- getUsage().runs[] como veio do Cursor (local: grupos por turno com UUID). Sem junção por posição com turns.
CREATE TABLE usage_runs (
  attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id),
  usage_id          TEXT NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  raw_cents         REAL,
  charged_cents     REAL,
  PRIMARY KEY (attempt_id, usage_id)
);

CREATE TABLE metrics (
  exec_id    TEXT NOT NULL REFERENCES runs(exec_id),
  name       TEXT NOT NULL,
  value_num  REAL,
  value_text TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX metrics_name ON metrics(name);

-- Fallback para estimar custo quando o Cursor não reporta raw_cents. Edite por SQL (sqlite3) ou pelo seed.
-- pattern: GLOB sobre model_id (ex.: '*haiku*5*5*'). Preços em USD por milhão de tokens.
CREATE TABLE pricing (
  pattern            TEXT NOT NULL,
  input_per_m        REAL NOT NULL,
  output_per_m       REAL NOT NULL,
  cache_read_per_m   REAL,
  cache_write_per_m  REAL,
  tier_threshold     INTEGER,               -- tokens de prompt por chamada a partir dos quais vale a tarifa alta
  input_above_per_m  REAL,
  output_above_per_m REAL,
  source             TEXT NOT NULL,
  effective_from     TEXT NOT NULL,
  PRIMARY KEY (pattern, effective_from)
);
INSERT INTO pricing VALUES
  -- Preços de lista do Cursor (cursor.com/docs/models-and-pricing, acesso 2026-11-11). O Auto não tem preço fixo.
  ('*composer*2*5*', 0.50, 2.50, 0.20, NULL, NULL, NULL, NULL, 'cursor.com/docs/models-and-pricing', '2026-11-01'),
  ('*grok*4*7*', 2.00, 6.00, 0.50, NULL, NULL, NULL, NULL, 'cursor.com/docs/models-and-pricing (sem Fast)', '2026-11-01'),
  ('*haiku*5*5*', 0.10, 0.50, 0.01, 0.125, 100000, 0.50, 2.50, 'cursor.com/docs/models-and-pricing (acima de 100k tokens de input: 5x; o cache acima da faixa não é modelado)', '2026-11-01'),
  ('*sonnet*5*5*', 2.00, 10.00, 0.10, 2.50, NULL, NULL, NULL, 'cursor.com/docs/models-and-pricing', '2026-11-01'),
  ('*opus*5*5*', 4.00, 20.00, 0.20, 5.00, NULL, NULL, NULL, 'cursor.com/docs/models-and-pricing', '2026-11-01');

-- ── Views de análise ─────────────────────────────────────────────────────────────────────────────

${vAttempts("a.model_id")}
-- Custo por run lógico (soma de todas as execuções/resumes do mesmo run_id).
CREATE VIEW v_runs AS
SELECT r.run_id, r.workflow, MIN(r.started_at) AS started_at, MAX(r.finished_at) AS finished_at,
       (SELECT r2.outcome_class FROM runs r2 WHERE r2.run_id = r.run_id ORDER BY r2.started_at DESC LIMIT 1) AS outcome_class,
       (SELECT r2.outcome_status FROM runs r2 WHERE r2.run_id = r.run_id ORDER BY r2.started_at DESC LIMIT 1) AS outcome_status,
       MAX(r.human_verdict) AS human_verdict,
       COUNT(DISTINCT r.exec_id) AS executions,
       (SELECT COALESCE(SUM(cost_cents), 0) FROM v_attempts va WHERE va.run_id = r.run_id) AS cost_cents,
       (SELECT COALESCE(SUM(prompt_tokens + output_tokens), 0) FROM v_attempts va WHERE va.run_id = r.run_id) AS tokens
FROM runs r GROUP BY r.run_id;

-- Por workflow: custo por ENTREGA (todo gasto, inclusive de runs que falharam, dividido pelas entregas).
CREATE VIEW v_workflow_summary AS
SELECT workflow,
       COUNT(*) AS runs,
       SUM(outcome_class = 'delivered') AS delivered,
       ROUND(1.0 * SUM(outcome_class = 'delivered') / COUNT(*), 3) AS delivery_rate,
       ROUND(SUM(cost_cents), 2) AS cost_cents,
       ROUND(SUM(cost_cents) / NULLIF(SUM(outcome_class = 'delivered'), 0), 2) AS cost_per_delivery_cents,
       SUM(tokens) AS tokens,
       SUM(human_verdict = 'rejected') AS human_rejected
FROM v_runs GROUP BY workflow;

-- Por modelo (+ params): eficiência das tentativas que chamaram a API.
CREATE VIEW v_model_summary AS
SELECT model_key,
       COUNT(*) AS attempts,
       ROUND(AVG(ok), 3) AS ok_rate,
       ROUND(SUM(cost_cents), 2) AS cost_cents,
       ROUND(SUM(cost_cents) / NULLIF(SUM(ok), 0), 3) AS cost_per_ok_attempt_cents,
       SUM(prompt_tokens) AS prompt_tokens,
       SUM(output_tokens) AS output_tokens,
       ROUND(1.0 * SUM(cache_read_tokens) / NULLIF(SUM(prompt_tokens), 0), 3) AS cache_share,
       ROUND(AVG(steps), 1) AS avg_steps,
       ROUND(AVG(schema_reprompts), 2) AS avg_reprompts,
       SUM(summaries) AS summaries
FROM v_attempts WHERE cached IS NULL GROUP BY model_key;

-- Custo e retorno por faixa de contexto médio por passo (25k). Custo por mil tokens subindo de faixa para faixa
-- indica tarifa por contexto; ok_rate caindo e passos subindo indicam o modelo "girando" sem entregar.
CREATE VIEW v_context_buckets AS
SELECT model_key, ctx_bucket_k,
       COUNT(*) AS attempts,
       ROUND(AVG(ok), 3) AS ok_rate,
       ROUND(AVG(steps), 1) AS avg_steps,
       ROUND(AVG(output_tokens), 0) AS avg_output_tokens,
       ROUND(SUM(cost_cents) * 1000.0 / NULLIF(SUM(prompt_tokens + output_tokens), 0), 4) AS cents_per_1k_tokens,
       ROUND(AVG(cost_cents), 3) AS avg_cost_cents,
       SUM(summaries) AS summaries
FROM v_attempts WHERE cached IS NULL AND cost_source = 'cursor'
GROUP BY model_key, ctx_bucket_k;

-- Economia: tentativas servidas por journal/memo × custo médio da mesma etapa quando rodou de verdade.
CREATE VIEW v_savings AS
SELECT c.workflow, c.cached, COUNT(*) AS hits,
       ROUND(SUM(COALESCE((SELECT AVG(x.cost_cents) FROM v_attempts x WHERE x.step_key = c.step_key AND x.cached IS NULL AND x.ok = 1), 0)), 2) AS est_saved_cents
FROM v_attempts c WHERE c.cached IS NOT NULL GROUP BY c.workflow, c.cached;

-- Desperdício: retries, re-prompts de schema e falhas por tipo.
CREATE VIEW v_waste AS
SELECT workflow, label, error_kind,
       COUNT(*) AS failed_attempts,
       ROUND(SUM(cost_cents), 2) AS cost_cents
FROM v_attempts WHERE ok = 0 GROUP BY workflow, label, error_kind;

CREATE VIEW v_daily AS
SELECT substr(started_at, 1, 10) AS day, workflow, model_key,
       ROUND(SUM(cost_cents), 2) AS cost_cents, SUM(prompt_tokens + output_tokens) AS tokens, COUNT(*) AS attempts
FROM v_attempts WHERE cached IS NULL GROUP BY day, workflow, model_key;

-- Custo do Cursor ainda não consolidado (rode wf metrics reconcile).
CREATE VIEW v_unreconciled AS
SELECT attempt_id, agent_id, started_at FROM attempts WHERE cached IS NULL AND cost_final = 0 AND agent_id IS NOT NULL;
`,
  // 2: modelo resolvido pelo Cursor (RunResult.model), usado na estimativa de preço quando existe.
  2: `
ALTER TABLE attempts ADD COLUMN resolved_model_id TEXT;
DROP VIEW v_attempts;
${vAttempts("COALESCE(a.resolved_model_id, a.model_id)")}`,
  // 3: prompt text no longer goes to the database (it lives only in the local event log). Deletes what older versions
  // stored with WF_METRICS_STORE_PROMPTS=1, so that not even an export without anonymizing carries it away.
  3: `
UPDATE attempts SET prompt_text = NULL WHERE prompt_text IS NOT NULL;`,
};
