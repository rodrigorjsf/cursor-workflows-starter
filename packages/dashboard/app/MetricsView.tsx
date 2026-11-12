// The Metrics menu: the cost and efficiency panels. They read `/api/summary` and draw their charts as SVG, with no chart
// library. A chart is drawn at the width it is shown (one SVG unit is one CSS pixel), so its labels keep their size on a phone;
// every number is written by `format.ts`, as on every other page.
//   1. daily spend per workflow  2. cost per delivery  3. cost per 1k tokens and success rate per context band
//   4. waste (failures, re-prompts) and savings (journal/memo)
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { dayLabel, formatCents, formatCount, formatNumber, formatPercent } from "./format.js";
import { Empty, Loaded, PageHeader } from "./Loaded.js";
import { usePoll } from "./usePoll.js";

type Row = Record<string, unknown>;
type Summary = Record<string, Row[]>;
/** How a column's values are written. */
type Kind = "text" | "count" | "cents" | "percent" | "number" | "band";
type Column = [key: string, title: string, kind: Kind];

const POLL_MS = 30_000;
const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];
const WINDOWS = ["7", "30", "90", "365"];
/** The text size of a chart's labels, in CSS pixels (the chart is drawn 1:1). */
const LABEL_PX = 12;
const CHART_HEIGHT = 200;

const num = (value: unknown): number => Number(value ?? 0);

/** A value as its column writes it; `–` when there is none. */
function cell(value: unknown, kind: Kind): string {
  if (value == null || value === "") return "–";
  if (kind === "text" || typeof value !== "number") return String(value);
  switch (kind) {
    case "count":
      return formatCount(value);
    case "cents":
      return formatCents(value);
    case "percent":
      return formatPercent(value);
    case "band":
      return `${formatCount(value)}k`;
    case "number":
      return formatNumber(value);
  }
}

function Table({ rows, cols, empty = "No data in this window." }: { rows: Row[]; cols: Column[]; empty?: string }) {
  if (rows.length === 0) return empty === "" ? null : <p className="note">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {cols.map(([key, title, kind]) => (
              <th key={key} scope="col" className={kind === "text" ? "" : "n"}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map(([key, title, kind]) => (
                <td key={key} data-label={title} className={kind === "text" ? "" : "n"}>
                  {cell(row[key], kind)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The width the element is shown at, followed as it changes: 0 until it is measured. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A chart drawn at the width its box is shown. */
function Measured({ children }: { children: (width: number) => ReactNode }) {
  const [ref, width] = useWidth();
  return (
    <div ref={ref} className="chart">
      {width > 0 && children(width)}
    </div>
  );
}

function Label({ x, y, anchor = "start", children }: { x: number; y: number; anchor?: "start" | "middle" | "end"; children: string }) {
  return (
    <text x={x} y={y} fontSize={LABEL_PX} textAnchor={anchor}>
      {children}
    </text>
  );
}

function Legend({ items }: { items: Array<[label: string, color: string, dashed?: boolean]> }) {
  return (
    <ul className="legend">
      {items.map(([label, color, dashed]) => (
        <li key={label}>
          <svg width="14" height="10" aria-hidden="true">
            {dashed ? <line x1="0" y1="5" x2="14" y2="5" stroke={color} strokeWidth="2" strokeDasharray="3 2" /> : <rect width="14" height="10" rx="2" fill={color} />}
          </svg>
          {label}
        </li>
      ))}
    </ul>
  );
}

export function DailyBars({ days, series, width }: { days: string[]; series: Row[]; width: number }) {
  if (days.length === 0) return <p className="note">No spend in this window.</p>;
  const H = CHART_HEIGHT;
  const left = 52;
  const top = 10;
  const bottom = 24;
  const keys = [...new Set(series.map((s) => String(s.workflow)))];
  const byDay: Record<string, Record<string, number>> = {};
  for (const s of series) (byDay[String(s.day)] ??= {})[String(s.workflow)] = num(s.cost_cents);
  const max = Math.max(1, ...days.map((d) => keys.reduce((total, k) => total + (byDay[d]?.[k] ?? 0), 0)));
  const plot = { w: Math.max(1, width - left - 4), h: H - top - bottom };
  const slot = plot.w / Math.max(days.length, 1);
  const bw = Math.max(2, Math.min(36, slot * 0.7));
  return (
    <>
      <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} role="img" aria-label="Daily spend by workflow">
        {[0, 0.5, 1].map((f) => {
          const y = top + plot.h * (1 - f);
          return (
            <g key={f} className="grid">
              <line x1={left} x2={width} y1={y} y2={y} />
              <Label x={left - 8} y={y + 4} anchor="end">
                {formatCents(max * f)}
              </Label>
            </g>
          );
        })}
        {days.map((d, i) => {
          let y = top + plot.h;
          return (
            <g key={d}>
              {keys.map((k, j) => {
                const v = byDay[d]?.[k] ?? 0;
                const h = (v / max) * plot.h;
                y -= h;
                return (
                  <rect key={k} x={left + i * slot + (slot - bw) / 2} y={y} width={bw} height={h} rx={2} fill={SERIES[j % SERIES.length]}>
                    <title>{`${dayLabel(d)} · ${k}: ${formatCents(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        <Label x={days.length === 1 ? left + slot / 2 : left} y={H - 6} anchor={days.length === 1 ? "middle" : "start"}>
          {dayLabel(days[0]!)}
        </Label>
        {days.length > 1 && (
          <Label x={width} y={H - 6} anchor="end">
            {dayLabel(days.at(-1)!)}
          </Label>
        )}
      </svg>
      <Legend items={keys.map((k, j) => [k, SERIES[j % SERIES.length]!])} />
    </>
  );
}

const CONTEXT_COLUMNS: Column[] = [
  ["ctx_bucket_k", "Context band", "band"],
  ["attempts", "Attempts", "count"],
  ["cents_per_1k_tokens", "Cost / 1k tokens", "cents"],
  ["ok_rate", "Success", "percent"],
  ["avg_steps", "Avg steps", "number"],
  ["summaries", "Summaries", "count"],
];

export function ContextLines({ rows, width }: { rows: Row[]; width: number }) {
  const H = CHART_HEIGHT;
  const left = 52;
  const right = 44;
  const top = 10;
  const bottom = 24;
  const xmax = Math.max(...rows.map((r) => num(r.ctx_bucket_k)), 25);
  const cmax = Math.max(...rows.map((r) => num(r.cents_per_1k_tokens)), 0.0001);
  const plot = { w: Math.max(1, width - left - right), h: H - top - bottom };
  const X = (x: number) => left + (x / xmax) * plot.w;
  const Yc = (v: number) => top + plot.h - (v / cmax) * plot.h;
  const Yo = (v: number) => top + plot.h - v * plot.h;
  const path = (y: (v: number) => number, key: string) => rows.map((r, i) => `${i ? "L" : "M"}${X(num(r.ctx_bucket_k))} ${y(num(r[key]))}`).join(" ");
  return (
    <>
      <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} role="img" aria-label="Cost and success by context band">
        {[0, 0.5, 1].map((f) => {
          const y = top + plot.h * (1 - f);
          return (
            <g key={f} className="grid">
              <line x1={left} x2={width - right} y1={y} y2={y} />
              <Label x={left - 8} y={y + 4} anchor="end">
                {formatCents(cmax * f)}
              </Label>
              <Label x={width - right + 8} y={y + 4}>
                {formatPercent(f)}
              </Label>
            </g>
          );
        })}
        <path d={path(Yc, "cents_per_1k_tokens")} fill="none" stroke="var(--chart-1)" strokeWidth={2} />
        <path d={path(Yo, "ok_rate")} fill="none" stroke="var(--chart-3)" strokeWidth={2} strokeDasharray="5 4" />
        {rows.map((r) => (
          <g key={String(r.ctx_bucket_k)}>
            {/* The ring first and wider, then the dot inside it: where the two meet (one band: both at the top), both show. */}
            <circle cx={X(num(r.ctx_bucket_k))} cy={Yo(num(r.ok_rate))} r={7} fill="var(--surface)" stroke="var(--chart-3)" strokeWidth={2}>
              <title>{`${cell(r.ctx_bucket_k, "band")}: ${formatPercent(num(r.ok_rate))} success · ${formatNumber(num(r.avg_steps))} steps on average`}</title>
            </circle>
            <circle cx={X(num(r.ctx_bucket_k))} cy={Yc(num(r.cents_per_1k_tokens))} r={4} fill="var(--chart-1)">
              <title>{`${cell(r.ctx_bucket_k, "band")}: ${formatCents(num(r.cents_per_1k_tokens))} per 1k tokens · ${formatCount(num(r.attempts))} attempts`}</title>
            </circle>
          </g>
        ))}
        <Label x={left} y={H - 6}>
          0k
        </Label>
        <Label x={width - right} y={H - 6} anchor="end">
          {`${formatCount(xmax)}k tokens / step`}
        </Label>
      </svg>
      <Legend
        items={[
          ["Cost per 1k tokens (left axis)", "var(--chart-1)"],
          ["Success rate (right axis)", "var(--chart-3)", true],
        ]}
      />
    </>
  );
}

const KPIS: Column[] = [
  ["runs", "Runs", "count"],
  ["cost_cents", "Cost", "cents"],
  ["tokens", "Tokens", "count"],
  ["cache_share", "Cache share", "percent"],
  ["failed_attempts", "Failed attempts", "count"],
  ["cached_steps", "Steps without an API call", "count"],
  ["unreconciled", "Costs to reconcile", "count"],
];

export function MetricsView() {
  const [days, setDays] = useState("30");
  const poll = usePoll<Summary>(`/api/summary?days=${days}`, POLL_MS);
  return (
    <>
      <PageHeader title="Metrics" summary="Cost and efficiency of the workflows. Cost is Cursor's raw cost when known, else an estimate from the pricing table.">
        <label className="field">
          <span>Window</span>
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </PageHeader>
      <Loaded poll={poll} what="the metrics">
        {(data) => <Panels data={data} />}
      </Loaded>
    </>
  );
}

function Panel({ title, wide, children, note }: { title: string; wide?: boolean; children: ReactNode; note?: ReactNode }) {
  return (
    <section className={`panel${wide ? " wide" : ""}`}>
      <h2>{title}</h2>
      {children}
      {note !== undefined && <p className="note">{note}</p>}
    </section>
  );
}

/** The panels for one answer of `/api/summary`. `width` draws the charts at that width; the page measures them instead. */
export function Panels({ data, width }: { data: Summary; width?: number }) {
  const [chosen, setChosen] = useState("");
  const totals: Row = data.totals?.[0] ?? {};
  const models = [...new Set((data.contextBuckets ?? []).map((r) => String(r.model_key)))];
  const model = models.includes(chosen) ? chosen : (models[0] ?? "");
  const daysWithSpend = [...new Set((data.daily ?? []).map((d) => String(d.day)))];
  const chart = (draw: (width: number) => ReactNode) => (width !== undefined ? draw(width) : <Measured>{draw}</Measured>);
  const contextRows = (data.contextBuckets ?? []).filter((r) => r.model_key === model);

  if (num(totals.runs) === 0 && (data.models ?? []).length === 0) {
    return <Empty title="No metrics in this window">The metrics database fills as workflows run. Pick a longer window, or start a run.</Empty>;
  }
  return (
    <div className="metrics">
      <dl className="kpis">
        {KPIS.map(([key, label, kind]) => (
          <div key={key} className="kpi">
            <dt>{label}</dt>
            <dd>{cell(totals[key], kind)}</dd>
          </div>
        ))}
      </dl>
      <div className="grid">
        <Panel title="Daily spend by workflow">{chart((w) => <DailyBars days={daysWithSpend} series={data.daily ?? []} width={w} />)}</Panel>
        <Panel title="Cost per delivery" note="All of a workflow's spend, failed runs included, divided by the runs it delivered.">
          <Table
            rows={data.workflows ?? []}
            cols={[
              ["workflow", "Workflow", "text"],
              ["runs", "Runs", "count"],
              ["delivered", "Delivered", "count"],
              ["delivery_rate", "Rate", "percent"],
              ["cost_cents", "Cost", "cents"],
              ["cost_per_delivery_cents", "Per delivery", "cents"],
              ["human_rejected", "Rejected", "count"],
            ]}
          />
        </Panel>
        <Panel
          title="Cost and success by context size"
          note="X axis: prompt tokens divided by the attempt's steps, an estimate of the context per call (the SDK does not expose the window). Cost per 1k tokens rising from band to band suggests context-based pricing; success falling as steps rise suggests the model is going in circles."
        >
          {models.length > 0 && (
            <label className="field">
              <span>Model</span>
              <select value={model} onChange={(e) => setChosen(e.target.value)}>
                {models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          )}
          {contextRows.length === 0 ? <p className="note">No attempts with a Cursor cost in this window.</p> : chart((w) => <ContextLines rows={contextRows} width={w} />)}
          <Table rows={contextRows} cols={CONTEXT_COLUMNS} empty="" />
        </Panel>
        <Panel title="Waste and savings">
          <h3>Failed attempts</h3>
          <Table
            rows={data.waste ?? []}
            cols={[
              ["workflow", "Workflow", "text"],
              ["label", "Step", "text"],
              ["error_kind", "Kind", "text"],
              ["failed_attempts", "Failed", "count"],
              ["cost_cents", "Cost", "cents"],
            ]}
          />
          <h3>Saved without calling the API</h3>
          <Table
            rows={data.savings ?? []}
            cols={[
              ["workflow", "Workflow", "text"],
              ["cached", "Source", "text"],
              ["hits", "Hits", "count"],
              ["est_saved_cents", "Saved (est.)", "cents"],
            ]}
          />
        </Panel>
        <Panel title="Models" wide>
          <Table
            rows={data.models ?? []}
            cols={[
              ["model_key", "Model", "text"],
              ["attempts", "Attempts", "count"],
              ["ok_rate", "Success", "percent"],
              ["cost_cents", "Cost", "cents"],
              ["cost_per_ok_cents", "Per success", "cents"],
              ["cache_share", "Cache share", "percent"],
              ["avg_steps", "Avg steps", "number"],
              ["avg_reprompts", "Avg re-prompts", "number"],
              ["max_ctx_per_step", "Max context / step", "count"],
              ["summaries", "Summaries", "count"],
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}
