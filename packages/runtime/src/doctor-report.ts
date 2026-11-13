// The shape of a `wf doctor` report, and how it prints. Standard library only: `node-check.ts` uses it to report a Node
// that is too old to load anything else.

/** The checks, in the order the report lists them. Scripts reading `--json` key on these ids. */
export const CHECK_TITLES = {
  node: "Node.js",
  dependencies: "Installed dependencies",
  login: "Cursor SDK login",
  models: "Configured models",
  forge: "Forge CLI",
  "mcp-server": "MCP server",
  config: "Configuration",
  "kit-version": "Kit version",
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
  `Install Node ${minimum} or newer and make it the default in the environment that starts the IDE (for example \`mise use -g node@22\` or \`nvm alias default 22\`), then restart the IDE. ` +
  "Check with `which node && node -v` in a terminal opened from the IDE itself.";

/** The report as text for a terminal: one block per check, the fix hint under each failure. */
export function formatReport(report: DoctorReport): string {
  const indent = (text: string) => text.split("\n").join("\n        ");
  const lines = report.checks.flatMap((c) => [
    `${c.status === "pass" ? "[ok]   " : "[FAIL] "} ${c.title}: ${indent(c.message)}`,
    ...(c.status === "fail" && c.hint ? [`        how to fix: ${indent(c.hint)}`] : []),
  ]);
  const failed = report.checks.filter((c) => c.status === "fail").length;
  lines.push("", failed ? `${failed} of ${report.checks.length} checks failed.` : `All good: ${report.checks.length} checks passed.`);
  return `${lines.join("\n")}\n`;
}
