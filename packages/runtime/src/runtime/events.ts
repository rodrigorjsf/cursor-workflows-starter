// Eventos de um run: o tipo `WorkflowEvent` e as interfaces de cada evento.
//
// Este arquivo é a fonte da referência de eventos (docs/reference/events.md): `scripts/events-reference.ts` lê as
// interfaces daqui, com os comentários de documentação, e a página é regerada a cada mudança (o `npm test` falha se
// ela divergir). Por isso: um evento = uma `interface` que estende `EventBase` e tem o campo literal `type`; os campos
// e os comentários `/** ... */` são a documentação. Compartilhe campos por `extends`, não por tipos auxiliares.

import type { ModelSelection, RunUsage, SettingSource } from "@cursor/sdk";
import type { UsageTotals } from "./workflow.js";

/** Versão atual do esquema dos eventos. Suba quando um campo mudar de sentido ou for removido (campos novos opcionais não exigem). */
export const EVENT_SCHEMA_VERSION = 1;

/** Tokens de um turno do agente (evento `turn-ended` do SDK: soma de todos os passos do turno). */
export interface TurnUsage {
  /** Tokens de entrada do turno. Já incluem os lidos e escritos no cache (medido). */
  inputTokens: number;
  /** Tokens de saída do turno. */
  outputTokens: number;
  /** Parte da entrada lida do cache de prompt do provedor. */
  cacheReadTokens: number;
  /** Parte da entrada escrita no cache de prompt do provedor. */
  cacheWriteTokens: number;
  /** Tokens de raciocínio do turno, quando o modelo os reporta. */
  reasoningTokens?: number;
}

/** Por que uma tentativa de etapa falhou: estourou o tempo, o run do agente terminou em erro, o JSON do schema nunca veio válido, limite de uso do plano, ou exceção. */
export type ErrorKind = "timeout" | "run-error" | "schema" | "rate-limit" | "exception";

/** Campos de todo evento. */
export interface EventBase {
  /** Versão do esquema do evento (hoje 1). Quem lê trata uma versão maior, ou um `type` desconhecido, como opaco. */
  v: number;
  /** Instante em que o evento foi emitido: ISO 8601 em UTC. */
  ts: string;
  /** Id do run. Um resume continua o mesmo run e acrescenta ao mesmo log. */
  runId: string;
}

/**
 * Posição de uma etapa (uma chamada de `agent()`) na estrutura do run. As três ids bastam para montar o grafo do run
 * só com os eventos: nós = etapas e grupos, arestas = `parentId`, agrupamento = `groupId`.
 */
export interface StepRef {
  /** Identifica a etapa. É o mesmo em todas as tentativas e em todo resume do run (deriva da chave do journal). */
  stepId: string;
  /**
   * O nó (etapa ou grupo) de que esta etapa continua: a etapa anterior da sequência, o estágio anterior do mesmo item
   * de um `pipeline`, ou o grupo que a abriu quando é a primeira do ramo. `null` na primeira etapa do run.
   */
  parentId: string | null;
  /** O `parallel` ou `pipeline` mais interno que contém a etapa; `null` fora de qualquer grupo. */
  groupId: string | null;
}

/** Mensagem de `ctx.log`. */
export interface LogEvent extends EventBase {
  type: "log";
  /** O texto passado a `ctx.log`. */
  message: string;
}

/** Mudança de fase (`ctx.phase`). As etapas seguintes ficam nessa fase. */
export interface PhaseEvent extends EventBase {
  type: "phase";
  /** O título passado a `ctx.phase`. */
  title: string;
}

/** O run começou (ou foi retomado: cada execução emite o seu). */
export interface RunStartEvent extends EventBase {
  type: "run-start";
  /** `meta.name` do workflow. */
  workflow: string;
  /** Hash do código e da meta do workflow: compare métricas só entre versões iguais. */
  workflowHash: string;
  /** Hash dos args: dá para ver que dois runs tiveram a mesma entrada sem guardar a entrada. */
  argsHash: string;
  /** O repositório do run: nome da pasta raiz do git e um hash curto do remote `origin` (ou do caminho). */
  repo: { name: string; hash: string };
}

/** O run terminou. */
export interface RunEndEvent extends EventBase {
  type: "run-end";
  /** `finished` = o workflow retornou; `failed` = lançou um erro (inclusive teto de custo ou de tokens). */
  status: "finished" | "failed";
  /** O campo `status` do resultado do workflow, quando ele devolve um objeto com esse campo (por exemplo `done`). */
  outcomeStatus?: string;
  /** A mensagem do erro que encerrou o run. */
  error?: string;
}

/** Um `parallel` ou `pipeline` começou. Os ramos são etapas com este `groupId`; o grupo fecha com `group-end`. */
export interface GroupStartEvent extends EventBase {
  type: "group-start";
  /** Identifica o grupo. Estável entre execuções do mesmo run: nasce da posição do grupo no código do workflow. */
  groupId: string;
  /** `parallel` (ramos independentes) ou `pipeline` (cada item atravessa os estágios por conta própria). */
  kind: "parallel" | "pipeline";
  /** Número de ramos: thunks do `parallel`, itens do `pipeline`. */
  size: number;
  /** O nó de que o grupo continua (mesmo sentido de `parentId` nas etapas); `null` no início do run. */
  parentId: string | null;
  /** O grupo que contém este (grupos aninhados); `null` no nível de cima. */
  parentGroupId: string | null;
}

/** O grupo terminou: o que vem depois dele no código continua deste nó. */
export interface GroupEndEvent extends EventBase {
  type: "group-end";
  /** O grupo que fecha: o `groupId` do `group-start`. */
  groupId: string;
  /** false quando um erro fatal (teto, conta) abortou o grupo. Ramos que falharam sem ser fatais viram `null` e avisos. */
  ok: boolean;
}

/** Uma tentativa de etapa começou (ou uma etapa foi servida do journal ou do memo, sem chamar a API). */
export interface StepStartEvent extends EventBase, StepRef {
  type: "step-start";
  /** Identifica a tentativa: liga o `step-start`, os `turn` e o `step-end` dela. Uma etapa tem uma tentativa por retry. */
  attemptId: string;
  /** Chave do journal: hash do prompt e das opções + nº da ocorrência. `stepId` é a forma curta dela. */
  stepKey: string;
  /** O `label` da etapa; sem ele, `etapa-` e um hash do prompt (nunca o começo do prompt). */
  label: string;
  /** A fase em que a etapa começou (`phase` da chamada ou o último `ctx.phase`). */
  phase?: string;
  /** De onde vem o resultado sem chamar a API: journal do run (resume) ou memo entre runs. `false` = tentativa real. */
  cached: false | "journal" | "memo";
  /** O ID do modelo pedido. */
  model?: string;
  /** Modelo + parâmetros ordenados, como `composer-2[reasoning_effort=low]`: esforço e contexto contam como modelos distintos. */
  modelKey?: string;
  /** Os parâmetros do modelo pedidos (esforço de raciocínio, contexto…). */
  modelParams?: ModelSelection["params"];
  /** Número da tentativa, a partir de 1. */
  attempt: number;
  /** A allowlist de tools da etapa, quando há. */
  tools?: string[];
  /** As camadas de configuração que a etapa carrega. */
  settingSources: SettingSource[];
  /** Hash do prompt: o conteúdo não vai para o log por padrão. */
  promptHash: string;
  /** Tamanho do prompt em caracteres. */
  promptChars: number;
  /** Só quando WF_METRICS_STORE_PROMPTS=1. */
  prompt?: string;
}

/** Um turno do agente terminou (pode ter vários passos/chamadas ao modelo). */
export interface TurnEvent extends EventBase, StepRef {
  type: "turn";
  /** A tentativa a que o turno pertence (o `attemptId` do `step-start`). */
  attemptId: string;
  /** Número do turno na tentativa, a partir de 0. */
  idx: number;
  /** Passos (chamadas ao modelo) do turno. */
  steps: number;
  /** Tokens do turno. */
  usage: TurnUsage;
}

/** Uma tentativa de etapa terminou (ou a etapa foi servida do journal ou do memo). */
export interface StepEndEvent extends EventBase, StepRef {
  type: "step-end";
  /** A tentativa que terminou (o `attemptId` do `step-start`). */
  attemptId: string;
  /** Chave do journal da etapa: igual à do `step-start`. */
  stepKey: string;
  /** O `label` da etapa. */
  label: string;
  /** A fase da etapa. */
  phase?: string;
  /** Número da tentativa; ausente quando a etapa foi servida do journal ou do memo. */
  attempt?: number;
  /** A tentativa entregou um resultado válido. */
  ok: boolean;
  /** De onde veio o resultado sem chamar a API: journal do run (resume) ou memo entre runs. */
  cached: false | "journal" | "memo";
  /** O que o Cursor cobrou pela tentativa (0 para uso incluído no plano). */
  chargedCents: number;
  /** O custo bruto reportado. O teto de custo usa o maior entre o bruto e o cobrado. */
  rawCents?: number;
  /** false = o Cursor ainda não tinha reportado custo; `wf metrics reconcile` completa depois. */
  costFinal?: boolean;
  /** O ID do modelo pedido. */
  model?: string;
  /** `RunResult.model.id`: o ID que o Cursor resolveu (alias → ID do catálogo). Com `default` (Auto), continua `default`. */
  resolvedModel?: string;
  /** Modelo + parâmetros, como no `step-start`. */
  modelKey?: string;
  /** Tokens da tentativa por tipo, como o Cursor os reportou. */
  usage?: UsageTotals;
  /** Tokens de raciocínio, quando o modelo os reporta. */
  reasoningTokens?: number;
  /** Por que a tentativa falhou, quando `ok` é false. */
  errorKind?: ErrorKind;
  /** A mensagem do erro, quando `ok` é false. */
  error?: string;
  /** Re-prompts feitos até o agente chamar `submit_result` com JSON válido. */
  schemaReprompts?: number;
  /** Turnos do agente na tentativa. */
  turns?: number;
  /** Passos (chamadas ao modelo) na tentativa. */
  steps?: number;
  /** Chamadas de tool por nome. */
  toolCalls?: Record<string, number>;
  /** Vezes que o contexto foi resumido durante a tentativa. */
  summaries?: number;
  /** O id do agente no Cursor. */
  agentId?: string;
  /** O uso por run do agente, como o Cursor o reporta. */
  usageRuns?: RunUsage[];
  /** Duração da tentativa em milissegundos. */
  durationMs?: number;
}

/** Métrica de negócio do run (`ctx.metric`). */
export interface MetricEvent extends EventBase {
  type: "metric";
  /** O nome passado a `ctx.metric`. */
  name: string;
  /** O valor passado a `ctx.metric`. */
  value: number | string;
}

/** Aviso que não derruba o run: custo não reportado, ramo que falhou, workflow que mudou entre execuções… */
export interface WarningEvent extends EventBase {
  type: "warning";
  /** O texto do aviso, para quem lê o run. */
  message: string;
}

export type WorkflowEvent =
  | LogEvent
  | PhaseEvent
  | RunStartEvent
  | RunEndEvent
  | GroupStartEvent
  | GroupEndEvent
  | StepStartEvent
  | TurnEvent
  | StepEndEvent
  | MetricEvent
  | WarningEvent;

type WithoutBase<E> = E extends EventBase ? Omit<E, keyof EventBase> : never;

/** Um evento como o motor o monta: sem `v`, `ts` e `runId`, que o log carimba ao emitir. */
export type NewEvent = WithoutBase<WorkflowEvent>;
