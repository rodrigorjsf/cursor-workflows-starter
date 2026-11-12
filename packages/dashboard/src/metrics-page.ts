// The metrics page: one HTML document, four panels drawn as SVG in the browser, with no library and no CDN, so it works
// offline and under a strict content security policy:
//   1. daily spend per workflow  2. cost per delivery  3. cost per 1k tokens and success rate per context band
//   4. waste (failures, re-prompts) and savings (journal/memo)
// It reads `/api/summary`. Until the app shell (runs, board, DAG) exists, this is the page the dashboard serves at `/`.

export const METRICS_PAGE = /* html */ `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workflow Metrics</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b6470;--line:#e3e6ea;--card:#f7f8fa;--a:#2f6fdf;--b:#d9822b;--c:#2e9e6b;--d:#b94a8c;--e:#6b6fd6;--f:#8a8f2b}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2a2f36;--card:#1a1d21}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 8px}
.sub{color:var(--muted);margin-bottom:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}
.kpi b{display:block;font-size:20px}.kpi span{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:12px}
@media (max-width:600px){.grid{grid-template-columns:1fr}}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}
.note{color:var(--muted);font-size:12px;margin-top:6px}.legend span{display:inline-block;margin-right:10px;font-size:12px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
svg text{fill:var(--muted);font-size:11px}
</style></head><body><main>
<h1>Métricas dos workflows</h1>
<div class="sub">Banco local por usuário · custo = <b>raw</b> do Cursor (sem descontos) quando disponível, senão estimativa da tabela <code>pricing</code> ·
janela <select id="days"><option>7</option><option selected>30</option><option>90</option><option>365</option></select> dias</div>
<div class="kpis" id="kpis"></div>
<div class="grid">
<section><h2>1 · Gasto diário por workflow (¢)</h2><div id="daily"></div><div class="legend" id="dailyLegend"></div></section>
<section><h2>2 · Custo por entrega</h2><div id="workflows"></div>
<div class="note">Custo por entrega = todo o gasto do workflow (inclusive runs que falharam) ÷ runs entregues.</div></section>
<section><h2>3 · Faixa de contexto médio por passo × custo e sucesso</h2>
<div>modelo <select id="model"></select></div><div id="buckets"></div>
<div class="note">Eixo X: tokens de prompt ÷ passos da tentativa (aproximação do contexto por chamada; o SDK não expõe a janela).
Custo por 1k tokens subindo de faixa para faixa sugere tarifa por contexto; sucesso caindo com passos subindo sugere o modelo "girando".</div></section>
<section><h2>4 · Desperdício e economia</h2><div id="waste"></div><div id="savings"></div></section>
<section style="grid-column:1/-1"><h2>Modelos</h2><div id="models"></div></section>
</div></main>
<script>
const COLORS=["var(--a)","var(--b)","var(--c)","var(--d)","var(--e)","var(--f)"];
const fmt=v=>v==null?"–":typeof v==="number"?(Math.abs(v)>=1000?v.toLocaleString("pt-BR",{maximumFractionDigits:0}):v.toLocaleString("pt-BR",{maximumFractionDigits:3})):String(v);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function table(rows,cols){if(!rows.length)return'<div class="note">sem dados na janela</div>';
 return'<table><tr>'+cols.map(c=>'<th>'+esc(c[1])+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>{const v=r[c[0]];return'<td class="'+(typeof v==="number"?"n":"")+'">'+esc(fmt(v))+'</td>'}).join('')+'</tr>').join('')+'</table>'}
function bars(el,days,series,legendEl){const W=520,H=200,P=30;const keys=[...new Set(series.map(s=>s.workflow))];
 const byDay={};for(const s of series){(byDay[s.day]??={})[s.workflow]=s.cost_cents}
 const max=Math.max(1,...days.map(d=>keys.reduce((a,k)=>a+(byDay[d]?.[k]??0),0)));const bw=Math.min(40,Math.max(2,(W-P)/Math.max(days.length,1)-2));
 let svg='<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="gasto diário">';
 days.forEach((d,i)=>{let y=H-20;keys.forEach((k,j)=>{const v=byDay[d]?.[k]??0;const h=v/max*(H-40);y-=h;
  svg+='<rect x="'+(P+i*(bw+2))+'" y="'+y+'" width="'+bw+'" height="'+h+'" fill="'+COLORS[j%6]+'"><title>'+esc(d+" · "+k+": "+fmt(v)+"¢")+'</title></rect>'})});
 svg+='<text x="0" y="12">'+fmt(max)+'¢</text><text x="'+P+'" y="'+(H-4)+'">'+esc(days[0]??"")+'</text><text x="'+(W-70)+'" y="'+(H-4)+'">'+esc(days.at(-1)??"")+'</text></svg>';
 el.innerHTML=days.length?svg:'<div class="note">sem dados na janela</div>';
 legendEl.innerHTML=keys.map((k,j)=>'<span><i style="background:'+COLORS[j%6]+'"></i>'+esc(k)+'</span>').join('')}
function lines(el,rows){const W=520,H=200,P=36;if(!rows.length){el.innerHTML='<div class="note">sem tentativas com custo do Cursor nesta faixa</div>';return}
 const xs=rows.map(r=>r.ctx_bucket_k),xmax=Math.max(...xs,25),cmax=Math.max(...rows.map(r=>r.cents_per_1k_tokens??0),0.0001);
 const X=x=>P+x/xmax*(W-P-10),Yc=v=>H-20-v/cmax*(H-40),Yo=v=>H-20-v*(H-40);
 const path=(f,k)=>rows.map((r,i)=>(i?'L':'M')+X(r.ctx_bucket_k)+' '+f(r[k]??0)).join(' ');
 el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="faixas de contexto">'+
 '<path d="'+path(Yc,"cents_per_1k_tokens")+'" fill="none" stroke="var(--a)" stroke-width="2"/>'+
 '<path d="'+path(Yo,"ok_rate")+'" fill="none" stroke="var(--c)" stroke-width="2" stroke-dasharray="4 3"/>'+
 rows.map(r=>'<circle cx="'+X(r.ctx_bucket_k)+'" cy="'+Yc(r.cents_per_1k_tokens??0)+'" r="3" fill="var(--a)"><title>'+esc(r.ctx_bucket_k+"k: "+fmt(r.cents_per_1k_tokens)+"¢/1k · sucesso "+fmt(r.ok_rate)+" · "+r.attempts+" tentativas · "+fmt(r.avg_steps)+" passos")+'</title></circle>').join('')+
 '<text x="0" y="12">'+fmt(cmax)+'¢/1k</text><text x="'+P+'" y="'+(H-4)+'">0k</text><text x="'+(W-60)+'" y="'+(H-4)+'">'+xmax+'k tokens/passo</text></svg>'+
 '<div class="legend"><span><i style="background:var(--a)"></i>¢ por 1k tokens</span><span><i style="background:var(--c)"></i>taxa de sucesso (0–1)</span></div>'+
 table(rows,[["ctx_bucket_k","faixa (k)"],["attempts","tentativas"],["cents_per_1k_tokens","¢/1k tok"],["ok_rate","sucesso"],["avg_steps","passos"],["summaries","compactações"]])}
let data;
async function load(){const days=document.getElementById("days").value;data=await (await fetch("/api/summary?days="+days)).json();render()}
function render(){const t=data.totals[0]??{};
 document.getElementById("kpis").innerHTML=[["runs","runs"],["cost_cents","custo (¢)"],["tokens","tokens"],["cache_share","parcela em cache"],["failed_attempts","tentativas falhas"],["cached_steps","etapas sem API"],["unreconciled","custos a reconciliar"]]
  .map(([k,l])=>'<div class="kpi"><b>'+esc(fmt(t[k]))+'</b><span>'+l+'</span></div>').join('');
 const days=[...new Set(data.daily.map(d=>d.day))];bars(document.getElementById("daily"),days,data.daily,document.getElementById("dailyLegend"));
 document.getElementById("workflows").innerHTML=table(data.workflows,[["workflow","workflow"],["runs","runs"],["delivered","entregues"],["delivery_rate","taxa"],["cost_cents","custo ¢"],["cost_per_delivery_cents","¢/entrega"],["human_rejected","rejeitados"]]);
 const sel=document.getElementById("model"),models=[...new Set(data.contextBuckets.map(r=>r.model_key))],cur=sel.value;
 sel.innerHTML=models.map(m=>'<option'+(m===cur?' selected':'')+'>'+esc(m)+'</option>').join('');
 lines(document.getElementById("buckets"),data.contextBuckets.filter(r=>r.model_key===sel.value));
 document.getElementById("waste").innerHTML='<h2 style="font-size:13px">Tentativas que falharam</h2>'+table(data.waste,[["workflow","workflow"],["label","etapa"],["error_kind","tipo"],["failed_attempts","n"],["cost_cents","custo ¢"]]);
 document.getElementById("savings").innerHTML='<h2 style="font-size:13px;margin-top:10px">Economia sem chamar a API</h2>'+table(data.savings,[["workflow","workflow"],["cached","origem"],["hits","hits"],["est_saved_cents","¢ economizados (est.)"]]);
 document.getElementById("models").innerHTML=table(data.models,[["model_key","modelo"],["attempts","tentativas"],["ok_rate","sucesso"],["cost_cents","custo ¢"],["cost_per_ok_cents","¢/sucesso"],["cache_share","cache"],["avg_steps","passos"],["avg_reprompts","re-prompts"],["max_ctx_per_step","ctx/passo máx"],["summaries","compactações"]])}
document.getElementById("days").onchange=load;document.getElementById("model").onchange=render;load();
</script></body></html>`;
