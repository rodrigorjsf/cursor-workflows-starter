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
  sandbox: "SDK sandbox",
  kit: "Installed kit",
} as const;

export type CheckId = keyof typeof CHECK_TITLES;

export interface CheckResult {
  id: CheckId;
  title: string;
  /** `warn`: the check passed, but what it found is worth fixing (a GitHub token broader than the kit needs). It never fails the report. */
  status: "pass" | "warn" | "fail";
  /** What was found (several lines when there are several problems). */
  message: string;
  /** How to fix it. Present on every failure and every warning. */
  hint?: string;
}

export interface DoctorReport {
  /** True when no check failed: a warning leaves it true. */
  ok: boolean;
  checks: CheckResult[];
}

export const pass = (id: CheckId, message: string): CheckResult => ({ id, title: CHECK_TITLES[id], status: "pass", message });
export const warn = (id: CheckId, message: string, hint: string): CheckResult => ({ id, title: CHECK_TITLES[id], status: "warn", message, hint });
export const fail = (id: CheckId, message: string, hint: string): CheckResult => ({ id, title: CHECK_TITLES[id], status: "fail", message, hint });

export const reportOf = (checks: CheckResult[]): DoctorReport => ({ ok: checks.every((c) => c.status !== "fail"), checks });

/** How to get the Node the kit needs: `minimum` is `22.13`, say. */
export const nodeHint = (minimum: string): string =>
  `Install Node ${minimum} or newer and make it the default in the environment that starts the IDE (for example \`mise use -g node@22\` or \`nvm alias default 22\`), then restart the IDE. ` +
  "Check with `which node && node -v` in a terminal opened from the IDE itself.";

/** The marker that starts a check's block in the text report, padded to one width. */
const MARKERS: Record<CheckResult["status"], string> = { pass: "[ok]   ", warn: "[warn] ", fail: "[FAIL] " };

/** How many checks warned, as the reports say it: `1 with a warning`, `2 with warnings`. */
export const withWarnings = (warned: number): string => `${warned} with ${warned === 1 ? "a warning" : "warnings"}`;

/** The last line of the text report: how many checks failed or, when none did, how many passed; warnings are counted in either case. */
function summaryLine(total: number, failed: number, warned: number): string {
  const warnings = warned === 0 ? "" : withWarnings(warned);
  if (failed > 0) return `${failed} of ${total} checks failed${warnings && `, ${warnings}`}.`;
  return warned > 0 ? `All ${total} checks passed, ${warnings}.` : `All good: ${total} checks passed.`;
}

/** The report as text for a terminal: one block per check, the fix hint under each failure and each warning. */
export function formatReport(report: DoctorReport): string {
  const indent = (text: string) => text.split("\n").join("\n        ");
  const lines = report.checks.flatMap((c) => [
    `${MARKERS[c.status]} ${c.title}: ${indent(c.message)}`,
    ...(c.status !== "pass" && c.hint ? [`        how to fix: ${indent(c.hint)}`] : []),
  ]);
  const count = (status: CheckResult["status"]) => report.checks.filter((c) => c.status === status).length;
  lines.push("", summaryLine(report.checks.length, count("fail"), count("warn")));
  return `${lines.join("\n")}\n`;
}
