// Tipos públicos do runtime de workflows sobre o Cursor SDK.
// Espelha a superfície do Workflow do Claude Code (agent/parallel/pipeline/phase/log/args/budget),
// mas roda como processo Node comum: o "script" é um módulo TypeScript que exporta defineWorkflow(...).
//
// STATUS: verificado contra a API real num plano Premium em 2026-11-11 (docs/research/verificacoes-locais.md).

import type { AgentDefinition, McpServerConfig, ModelSelection, SettingSource, ToolName } from "@cursor/sdk";

/** JSON Schema (subconjunto aceito pelo Ajv). */
export type JsonSchema = Record<string, unknown>;

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

/**
 * Whether a role's steps may run on a Cursor cloud agent (a later spec): `ok` as they are, `read-only` only when the
 * step reads and never writes, `never` always local (the step depends on the local worktree).
 */
export type CloudCapability = "ok" | "read-only" | "never";

/** What a role starts from, before the config layers change it. A call's own options override these. */
export type RoleDefaults = Pick<AgentCallOptions, "model" | "timeoutMs" | "retries" | "schemaRetries" | "settingSources">;

/**
 * A named kind of step of a workflow (`classify`, `implement.low`, `review`...). The names are the public contract of
 * the workflow's config: the keys under `workflows.<name>.roles` in the config files. A name the workflow does not
 * declare is an error, in the config and in `agent({ role })`.
 */
export interface WorkflowRole {
  /** Lowercase words joined by dots or dashes: `review`, `implement.low`. */
  name: string;
  /** One line: what the role's steps do. Shows up in `list_workflows`. */
  description?: string;
  cloud: CloudCapability;
  /** The role's code defaults. They sit above `WorkflowDefinition.defaults` and below the options of the `agent()` call. */
  defaults?: RoleDefaults;
  /**
   * Extra suffixes of the `WF_MODEL_<suffix>` env var that sets this role's model, besides the role name in upper case
   * with dots and dashes as underscores (`implement.low` -> `WF_MODEL_IMPLEMENT_LOW`). Keeps old variable names working.
   */
  envAliases?: string[];
}

export interface WorkflowMeta {
  /** Nome estável: o `name` do start_workflow (MCP) e o de `wf run <nome>` (CLI). */
  name: string;
  /** Uma linha. Aparece na listagem do MCP e no `--help` do CLI. */
  description: string;
  /** Quando usar — texto para o agente do chat decidir chamar a tool. */
  whenToUse?: string;
  phases?: WorkflowPhase[];
  /** JSON Schema dos args; o runtime valida (Ajv) antes de rodar e falha o run se não bater. */
  argsSchema?: JsonSchema;
  /** The roles of the workflow's steps. Config sets model, timeouts, retries... per role. */
  roles?: WorkflowRole[];
}

export interface AgentCallOptions {
  /** Rótulo no log/progresso. */
  label?: string;
  /**
   * The step's role, one of `meta.roles`. The config layers (global file, repo file, env, flags) set the step's model,
   * timeout, retries, schema retries and setting sources by role, and they win over the options of this call.
   * A role the workflow does not declare fails the step.
   */
  role?: string;
  /** Agrupa no progresso; use dentro de parallel/pipeline em vez de phase() global. */
  phase?: string;
  /**
   * Modelo desta etapa. Obrigatório para agentes locais no SDK; o runtime usa
   * `defaults.model` do workflow quando omitido. O SDK valida o ID (ou alias) contra o catálogo da
   * conta antes da run; ID fora do catálogo faz a etapa falhar.
   */
  model?: ModelSelection;
  /**
   * JSON Schema com `type: "object"` na raiz. Com schema, o agente precisa chamar a tool `submit_result`; o retorno é o objeto validado.
   * Sem schema, o retorno é o texto final do agente.
   */
  schema?: JsonSchema;
  /** Diretório de trabalho (ex.: um git worktree criado pelo workflow). Default: cwd do run. */
  cwd?: string;
  /** Allowlist de tools nativas (ex.: ["read","grep","glob","ls"] para etapas read-only). */
  tools?: ToolName[];
  disallowedTools?: ToolName[];
  /** Subagents inline disponíveis para esta etapa (via tool `task`). */
  agents?: Record<string, AgentDefinition>;
  mcpServers?: Record<string, McpServerConfig>;
  /** Tempo máximo da etapa. Ao estourar, a run é cancelada. Default 20 min. */
  timeoutMs?: number;
  /** Tentativas extras quando a run termina em erro/cancelada. Default 1. */
  retries?: number;
  /** Re-prompts quando o agente não chama `submit_result` ou envia JSON inválido. Default 2. */
  schemaRetries?: number;
  /**
   * Liga o sandbox local do SDK (`local.sandboxOptions.enabled`). Pela doc do SDK, ele restringe as chamadas de shell
   * e os processos que elas iniciam: escrita só no cwd, em diretórios temporários e nos caminhos do `sandbox.json`;
   * **leitura não é restringida**; rede negada exceto a allowlist de `.cursor/sandbox.json`. A doc não diz se cobre
   * as tools `edit`/`write`. No Linux exige `bubblewrap` (sem ele o SDK lança ConfigurationError). Não testado neste
   * kit. Testes que baixam pacotes podem falhar com ele ligado.
   */
  sandbox?: boolean;
  /**
   * Camadas de configuração que esta etapa carrega (sobrescreve o default do run).
   * Cada camada aumenta o contexto fixo de TODA chamada: regras, descrições de skills e de subagents
   * (injetadas na descrição da tool Task) e tools dos MCP servers do projeto. Etapas só de leitura usam []
   * (sem AGENTS.md, regras, hooks, MCP nem skills; o prompt lista os arquivos de contexto que importam).
   * ["team","mdm"] só quando a etapa precisa dos hooks do time ou MDM: ele ainda carrega as skills (docs/operating/02-custos-e-cache.md §4.3).
   * Regra em docs/operating/02-custos-e-cache.md §6.
   */
  settingSources?: SettingSource[];
  /**
   * Cache de resultado entre runs: se a mesma etapa (prompt + modelo + schema + tools + contexto) já
   * rodou com o repositório no mesmo estado (HEAD + mudanças locais), devolve o resultado salvo sem
   * chamar a API. Só para etapas sem efeitos: exige `tools` com apenas tools de leitura.
   */
  memo?: boolean;
}

/** Options of one `ctx.exec` call. */
export interface ExecOptions {
  /** Name of the command in the run's log and progress. Default: the command's name. */
  label?: string;
  /** Groups progress, like `AgentCallOptions.phase`. Default: the last `ctx.phase`. */
  phase?: string;
  /**
   * How long the command may run before it is killed (SIGTERM to its whole process group, SIGKILL two seconds later).
   * Default: the workflow's `execTimeoutMs` config preference, which defaults to 10 minutes.
   */
  timeoutMs?: number;
  /** Working directory. Default: the run's cwd. */
  cwd?: string;
  /** Environment variables added to this process's own. A variable set to `undefined` is removed from the command's environment. */
  env?: Record<string, string | undefined>;
}

/** What a `ctx.exec` call hands back. A command that fails, times out or cannot start is a result: the workflow decides what it means. */
export interface ExecResult {
  /** True when the command ran and exited with code 0. */
  ok: boolean;
  /** The exit code. `null` when the process was killed (at its timeout, or by a signal) or never started. */
  exitCode: number | null;
  /** True when the command was killed at its `timeoutMs`. */
  timedOut: boolean;
  /** The last 32768 characters of what the command wrote, stdout and stderr in the order they arrived. Not redacted: the log's copy is. */
  tail: string;
  /** Why the command could not start (a missing program, a bad cwd). Absent when it ran. */
  error?: string;
}

/** Uso de tokens somado (por etapa ou por run). `cacheRead`/`cacheWrite` vêm do provedor via Cursor. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface Budget {
  /**
   * Teto em centavos, comparado com `spentCents()`: a soma, por tentativa, do maior entre o custo bruto
   * (`rawCostCents`) e o cobrado (`chargedCents`). null = sem teto.
   */
  readonly maxCents: number | null;
  /** Teto de tokens totais. Vale mesmo sem custo reportado: se getUsage() falha, conta os tokens dos eventos turn-ended. */
  readonly maxTokens: number | null;
  /** Custo considerado pelo teto (ver `maxCents`). */
  spentCents(): number;
  /** Só o cobrado: 0 para uso incluído no plano, BYOK e créditos. */
  chargedCents(): number;
  spentTokens(): number;
  remainingCents(): number;
  /** Tokens somados por tipo, para medir aproveitamento de cache. */
  usage(): UsageTotals;
}

export interface WorkflowContext<A = unknown> {
  readonly args: A;
  readonly runId: string;
  readonly cwd: string;
  readonly budget: Budget;
  /** Executa uma etapa com um agente novo do Cursor SDK. Lança erro se falhar após as tentativas. */
  agent<T = string>(prompt: string, opts?: AgentCallOptions): Promise<T>;
  /** Barreira: roda tudo em paralelo e espera todos. Thunk que falha vira null. */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  /**
   * Sem barreira: cada item atravessa os estágios de forma independente.
   * Estágio que lança erro descarta o item (null) e pula os estágios seguintes.
   */
  pipeline<I>(
    items: I[],
    ...stages: Array<(prev: any, item: I, index: number) => Promise<any> | any>
  ): Promise<any[]>;
  /**
   * Runs a command (no shell: `command` and its `args`) without blocking the process, and returns its exit code and the
   * tail of its output. The command is killed at its timeout. Its output is streamed into the run's event log, redacted and
   * retained like an agent's content, and the call is a step node of the run. Use it for every command a workflow runs
   * itself (tests, `git`, `gh`): a synchronous call (`execFileSync`) freezes status queries and cancellation. A cancelled
   * run kills the command and throws. A resume runs the command again: `exec` is not journaled.
   */
  exec(command: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>;
  phase(title: string): void;
  log(message: string): void;
  /**
   * Métrica de negócio do run (vai para a tabela `metrics`): resultado de testes, achados de review, tamanho do
   * diff, dificuldade (tier)… É o que permite medir custo por entrega e controlar a dificuldade nas comparações.
   */
  metric(name: string, value: number | string): void;
}

export interface WorkflowDefinition<A = unknown, R = unknown> {
  meta: WorkflowMeta;
  /** Defaults aplicados a toda chamada agent() que não sobrescrever. */
  defaults?: Pick<AgentCallOptions, "model" | "timeoutMs" | "retries" | "schemaRetries" | "tools" | "sandbox">;
  /** Teto padrão do run quando quem chama não informa um (`--max-tokens`/`--max-cents`, ou o MCP); `null` explícito desliga. */
  budget?: { maxTokens?: number; maxCents?: number };
  run(ctx: WorkflowContext<A>): Promise<R>;
}

export function defineWorkflow<A = unknown, R = unknown>(def: WorkflowDefinition<A, R>): WorkflowDefinition<A, R> {
  return def;
}
