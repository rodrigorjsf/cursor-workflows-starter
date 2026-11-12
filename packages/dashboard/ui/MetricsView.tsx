// The Metrics menu: the cost and efficiency panels the dashboard has always had, now one view of the app. They read
// `/api/summary` and draw their charts as SVG, with no chart library. The text is the panels' own (Portuguese), unchanged.
//   1. daily spend per workflow  2. cost per delivery  3. cost per 1k tokens and success rate per context band
//   4. waste (failures, re-prompts) and savings (journal/memo)
import { useState } from "react";
import { usePoll } from "./usePoll.js";

type Row = Record<string, unknown>;
type Summary = Record<string, Row[]>;
type Column = [key: string, title: string];

const POLL_MS = 30_000;
const COLORS = ["var(--a)", "var(--b)", "var(--c)", "var(--d)", "var(--e)", "var(--f)"];

const fmt = (value: unknown): string =>
  value == null ? "–" : typeof value === "number" ? value.toLocaleString("pt-BR", { maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 3 }) : String(value);
const num = (value: unknown): number => Number(value ?? 0);

function Table({ rows, cols }: { rows: Row[]; cols: Column[] }) {
  if (rows.length === 0) return <div className="note">sem dados na janela</div>;
  return (
    <table>
      <thead>
        <tr>
          {cols.map(([, title]) => (
            <th key={title}>{title}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {cols.map(([key, title]) => (
              <td key={title} className={typeof row[key] === "number" ? "n" : ""}>
                {fmt(row[key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DailyBars({ days, series }: { days: string[]; series: Row[] }) {
  const W = 520;
  const H = 200;
  const P = 30;
  const keys = [...new Set(series.map((s) => String(s.workflow)))];
  const byDay: Record<string, Record<string, number>> = {};
  for (const s of series) (byDay[String(s.day)] ??= {})[String(s.workflow)] = num(s.cost_cents);
  const max = Math.max(1, ...days.map((d) => keys.reduce((total, k) => total + (byDay[d]?.[k] ?? 0), 0)));
  const bw = Math.min(40, Math.max(2, (W - P) / Math.max(days.length, 1) - 2));
  return (
    <>
      {days.length === 0 ? (
        <div className="note">sem dados na janela</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="gasto diário">
          {days.map((d, i) => {
            let y = H - 20;
            return (
              <g key={d}>
                {keys.map((k, j) => {
                  const v = byDay[d]?.[k] ?? 0;
                  const h = (v / max) * (H - 40);
                  y -= h;
                  return (
                    <rect key={k} x={P + i * (bw + 2)} y={y} width={bw} height={h} fill={COLORS[j % 6]}>
                      <title>{`${d} · ${k}: ${fmt(v)}¢`}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
          <text x={0} y={12}>{`${fmt(max)}¢`}</text>
          <text x={P} y={H - 4}>{days[0]}</text>
          <text x={W - 70} y={H - 4}>{days.at(-1)}</text>
        </svg>
      )}
      <div className="legend">
        {keys.map((k, j) => (
          <span key={k}>
            <i style={{ background: COLORS[j % 6] }} />
            {k}
          </span>
        ))}
      </div>
    </>
  );
}

const CONTEXT_COLUMNS: Column[] = [
  ["ctx_bucket_k", "faixa (k)"],
  ["attempts", "tentativas"],
  ["cents_per_1k_tokens", "¢/1k tok"],
  ["ok_rate", "sucesso"],
  ["avg_steps", "passos"],
  ["summaries", "compactações"],
];

function ContextLines({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <div className="note">sem tentativas com custo do Cursor nesta faixa</div>;
  const W = 520;
  const H = 200;
  const P = 36;
  const xmax = Math.max(...rows.map((r) => num(r.ctx_bucket_k)), 25);
  const cmax = Math.max(...rows.map((r) => num(r.cents_per_1k_tokens)), 0.0001);
  const X = (x: number) => P + (x / xmax) * (W - P - 10);
  const Yc = (v: number) => H - 20 - (v / cmax) * (H - 40);
  const Yo = (v: number) => H - 20 - v * (H - 40);
  const path = (y: (v: number) => number, key: string) => rows.map((r, i) => `${i ? "L" : "M"}${X(num(r.ctx_bucket_k))} ${y(num(r[key]))}`).join(" ");
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="faixas de contexto">
        <path d={path(Yc, "cents_per_1k_tokens")} fill="none" stroke="var(--a)" strokeWidth={2} />
        <path d={path(Yo, "ok_rate")} fill="none" stroke="var(--c)" strokeWidth={2} strokeDasharray="4 3" />
        {rows.map((r) => (
          <circle key={String(r.ctx_bucket_k)} cx={X(num(r.ctx_bucket_k))} cy={Yc(num(r.cents_per_1k_tokens))} r={3} fill="var(--a)">
            <title>{`${r.ctx_bucket_k}k: ${fmt(r.cents_per_1k_tokens)}¢/1k · sucesso ${fmt(r.ok_rate)} · ${r.attempts} tentativas · ${fmt(r.avg_steps)} passos`}</title>
          </circle>
        ))}
        <text x={0} y={12}>{`${fmt(cmax)}¢/1k`}</text>
        <text x={P} y={H - 4}>0k</text>
        <text x={W - 60} y={H - 4}>{`${xmax}k tokens/passo`}</text>
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: "var(--a)" }} />¢ por 1k tokens
        </span>
        <span>
          <i style={{ background: "var(--c)" }} />
          taxa de sucesso (0–1)
        </span>
      </div>
      <Table rows={rows} cols={CONTEXT_COLUMNS} />
    </>
  );
}

const KPIS: Column[] = [
  ["runs", "runs"],
  ["cost_cents", "custo (¢)"],
  ["tokens", "tokens"],
  ["cache_share", "parcela em cache"],
  ["failed_attempts", "tentativas falhas"],
  ["cached_steps", "etapas sem API"],
  ["unreconciled", "custos a reconciliar"],
];

export function MetricsView() {
  const [days, setDays] = useState("30");
  const [chosen, setChosen] = useState("");
  const { data, error } = usePoll<Summary>(`/api/summary?days=${days}`, POLL_MS);
  if (!data) return <p className={error ? "note error" : "note"}>{error ?? "Loading the metrics…"}</p>;

  const totals = data.totals?.[0] ?? {};
  const models = [...new Set((data.contextBuckets ?? []).map((r) => String(r.model_key)))];
  const model = models.includes(chosen) ? chosen : (models[0] ?? "");
  const daysWithSpend = [...new Set((data.daily ?? []).map((d) => String(d.day)))];

  return (
    <div className="metrics">
      <h2>Métricas dos workflows</h2>
      <div className="sub">
        Banco local por usuário · custo = <b>raw</b> do Cursor (sem descontos) quando disponível, senão estimativa da tabela <code>pricing</code> · janela{" "}
        <select aria-label="janela em dias" value={days} onChange={(e) => setDays(e.target.value)}>
          {["7", "30", "90", "365"].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>{" "}
        dias
      </div>
      <div className="kpis">
        {KPIS.map(([key, label]) => (
          <div key={key} className="kpi">
            <b>{fmt(totals[key])}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="grid">
        <section>
          <h3>1 · Gasto diário por workflow (¢)</h3>
          <DailyBars days={daysWithSpend} series={data.daily ?? []} />
        </section>
        <section>
          <h3>2 · Custo por entrega</h3>
          <Table
            rows={data.workflows ?? []}
            cols={[["workflow", "workflow"], ["runs", "runs"], ["delivered", "entregues"], ["delivery_rate", "taxa"], ["cost_cents", "custo ¢"], ["cost_per_delivery_cents", "¢/entrega"], ["human_rejected", "rejeitados"]]}
          />
          <div className="note">Custo por entrega = todo o gasto do workflow (inclusive runs que falharam) ÷ runs entregues.</div>
        </section>
        <section>
          <h3>3 · Faixa de contexto médio por passo × custo e sucesso</h3>
          <div>
            modelo{" "}
            <select aria-label="modelo" value={model} onChange={(e) => setChosen(e.target.value)}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <ContextLines rows={(data.contextBuckets ?? []).filter((r) => r.model_key === model)} />
          <div className="note">
            Eixo X: tokens de prompt ÷ passos da tentativa (aproximação do contexto por chamada; o SDK não expõe a janela). Custo por 1k tokens subindo de faixa para faixa sugere tarifa por contexto; sucesso caindo com passos
            subindo sugere o modelo &quot;girando&quot;.
          </div>
        </section>
        <section>
          <h3>4 · Desperdício e economia</h3>
          <h4>Tentativas que falharam</h4>
          <Table rows={data.waste ?? []} cols={[["workflow", "workflow"], ["label", "etapa"], ["error_kind", "tipo"], ["failed_attempts", "n"], ["cost_cents", "custo ¢"]]} />
          <h4>Economia sem chamar a API</h4>
          <Table rows={data.savings ?? []} cols={[["workflow", "workflow"], ["cached", "origem"], ["hits", "hits"], ["est_saved_cents", "¢ economizados (est.)"]]} />
        </section>
        <section className="wide">
          <h3>Modelos</h3>
          <Table
            rows={data.models ?? []}
            cols={[
              ["model_key", "modelo"],
              ["attempts", "tentativas"],
              ["ok_rate", "sucesso"],
              ["cost_cents", "custo ¢"],
              ["cost_per_ok_cents", "¢/sucesso"],
              ["cache_share", "cache"],
              ["avg_steps", "passos"],
              ["avg_reprompts", "re-prompts"],
              ["max_ctx_per_step", "ctx/passo máx"],
              ["summaries", "compactações"],
            ]}
          />
        </section>
      </div>
    </div>
  );
}
