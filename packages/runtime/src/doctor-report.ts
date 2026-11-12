// The shape of a `wf doctor` report, and how it prints. Standard library only: `node-check.ts` uses it to report a Node
// that is too old to load anything else.

/** The checks, in the order the report lists them. Scripts reading `--json` key on these ids. */
export const CHECK_TITLES = {
  node: "Node.js",
  dependencies: "Dependências instaladas",
  login: "Login no Cursor SDK",
  models: "Modelos da configuração",
  gh: "GitHub CLI (gh)",
  "mcp-server": "Servidor MCP",
  config: "Configuração",
  "kit-version": "Versão do kit",
} as const;

export type CheckId = keyof typeof CHECK_TITLES;

export interface CheckResult {
  id: CheckId;
  title: string;
  status: "pass" | "fail";
  /** What was found (several lines when there are several problems). */
  message: string;
  /** How to fix it. Present on every failure. */
  hint?: string;
}

export interface DoctorReport {
  /** True when every check passed. */
  ok: boolean;
  checks: CheckResult[];
}

export const pass = (id: CheckId, message: string): CheckResult => ({ id, title: CHECK_TITLES[id], status: "pass", message });
export const fail = (id: CheckId, message: string, hint: string): CheckResult => ({ id, title: CHECK_TITLES[id], status: "fail", message, hint });

export const reportOf = (checks: CheckResult[]): DoctorReport => ({ ok: checks.every((c) => c.status === "pass"), checks });

/** How to get the Node the kit needs: `minimum` is `22.13`, say. */
export const nodeHint = (minimum: string): string =>
  `Instale o Node ${minimum} ou mais novo e deixe-o como padrão no ambiente que inicia o IDE (por exemplo \`mise use -g node@22\` ou \`nvm alias default 22\`), depois reinicie o IDE. ` +
  "Confira com `which node && node -v` num terminal aberto pelo próprio IDE.";

/** The report as text for a terminal: one block per check, the fix hint under each failure. */
export function formatReport(report: DoctorReport): string {
  const indent = (text: string) => text.split("\n").join("\n        ");
  const lines = report.checks.flatMap((c) => [
    `${c.status === "pass" ? "[ok]   " : "[FALHA]"} ${c.title}: ${indent(c.message)}`,
    ...(c.status === "fail" && c.hint ? [`        como corrigir: ${indent(c.hint)}`] : []),
  ]);
  const failed = report.checks.filter((c) => c.status === "fail").length;
  lines.push("", failed ? `${failed} de ${report.checks.length} verificações falharam.` : `Tudo certo: ${report.checks.length} verificações passaram.`);
  return `${lines.join("\n")}\n`;
}
