// WHAT: Turns what the Cursor IDE validation wizard recorded (its progress file, plus the `wf doctor --json` output) into
//   `validation-report.json` and the Markdown body of the issue to file, with local paths, repository names, the account
//   and the machine anonymized and known credential formats redacted. Prints the issue title.
// WHY: The report leaves the machine (an issue on the kit's tracker), so what goes into it is decided by code with a
//   test, not by the wizard's shell. It also keeps the JSON valid whatever a person types into a note.
// WHEN: Called by scripts/verify/validate-cursor-ide.sh at its last stage; run it by hand only to rebuild a report
//   from a saved progress file.
// HOW: `tsx scripts/verify/validation-report.ts --progress <progress.env> --out-dir <dir> [--doctor <doctor.json>]
//   [--kit <kit dir>]`. The progress file is `KEY=value` lines: CURSOR_VERSION, IDE_TERMINAL (yes|no), SANDBOX_REPO,
//   SANDBOX_DIR, and S<n>_TITLE, S<n>_RESULT (pass|fail|skip), S<n>_NOTE per scenario. Exit 2 on a missing argument.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, release, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRedactor } from "../../packages/runtime/src/runtime/redaction.js";
import { isEntryPoint } from "../lib/cli.js";

type Result = "pass" | "fail" | "skipped";

interface Scenario {
  id: number;
  title: string;
  result: Result;
  note: string;
}

interface DoctorCheck {
  id: string;
  status: string;
  message: string;
  hint?: string;
}

interface Report {
  schemaVersion: 1;
  createdAt: string;
  kit: { version: string | null };
  environment: { platform: string; osRelease: string; wsl: boolean; node: string; cursorVersion: string | null; ideTerminal: boolean };
  doctor: { ok: boolean; checks: DoctorCheck[] } | null;
  scenarios: Scenario[];
  summary: { pass: number; fail: number; skipped: number; releaseCriterionMet: boolean };
}

/** `KEY=value` lines; the value is everything after the first `=`. Anything else is ignored. */
function parseProgress(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ""));
    if (m) values[m[1]!] = m[2]!;
  }
  return values;
}

/** What identifies the person, their account and their machine in the text the report is made of. */
interface Where {
  sandboxRepo?: string;
  sandboxDir?: string;
  kitDir?: string;
  home: string;
  user: string;
  host: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name (account, repository, user, host) is replaced as a whole word only: `rodrigo` inside `rodrigorjsf` stays. */
const wholeWord = (name: string) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g");

const EMAIL = /[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s"'`<>|*?]+/g;
/** An absolute path of two segments or more. One segment (`/tmp`, `/run-workflow`) is a word, and a URL's slashes follow `:` or a name. */
const POSIX_PATH = /(?<![\w.~<>/:-])\/[\w.@+%~=-]+(?:\/[\w.@+%~=-]+)+\/?/g;

/** The function that anonymizes one string: credentials, then the known places and names (longest first), then any other path or email. */
function anonymizer(where: Where, env: NodeJS.ProcessEnv = process.env): (text: string) => string {
  const redactor = createRedactor({ env });
  const places: Array<[RegExp, string]> = [];
  const place = (value: string | undefined, replacement: string) => {
    if (value && value.length > 1) places.push([new RegExp(escapeRegExp(value), "g"), replacement]);
  };
  // A bare name goes wherever it appears in what the person wrote, even as an ordinary word: privacy over prose. Four
  // characters at least, so `dev` or `me` do not eat every sentence.
  const name = (value: string | undefined, replacement: string) => {
    if (value && value.length >= 4) places.push([wholeWord(value), replacement]);
  };
  const [owner, repoName] = (where.sandboxRepo ?? "").split("/");
  // Longest first, so a folder inside the home is named by its own placeholder and not as a path under `~`.
  const literals: Array<[string | undefined, string]> = [
    [where.sandboxRepo, "<sandbox-repo>"],
    [where.sandboxDir, "<sandbox-dir>"],
    [where.kitDir, "<kit>"],
    [where.home === "/" ? undefined : where.home, "~"],
  ];
  for (const [value, replacement] of literals.sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))) place(value, replacement);
  name(repoName, "<sandbox-repo>");
  name(owner, "<owner>");
  name(where.host, "<host>");
  name(where.user, "<user>");
  return (text) => {
    let out = redactor.text(text);
    for (const [pattern, replacement] of places) out = out.replace(pattern, replacement);
    return out.replace(EMAIL, "<email>").replace(WINDOWS_PATH, "<path>").replace(POSIX_PATH, "<path>");
  };
}

/**
 * The report with `fn` applied to the text people and machines wrote: the notes, the Cursor version and what `wf doctor`
 * said. The scenario titles and the check ids are the wizard's own words and stay as they are.
 */
function anonymizeFreeText(report: Report, fn: (text: string) => string): Report {
  const { environment, doctor, scenarios } = report;
  return {
    ...report,
    environment: { ...environment, cursorVersion: environment.cursorVersion === null ? null : fn(environment.cursorVersion) },
    doctor: doctor && { ok: doctor.ok, checks: doctor.checks.map((c) => ({ ...c, message: fn(c.message), ...(c.hint === undefined ? {} : { hint: fn(c.hint) }) })) },
    scenarios: scenarios.map((s) => ({ ...s, note: fn(s.note) })),
  };
}

/** The release criterion of the foundation spec: "works in the Cursor IDE" means these many scenarios pass. */
const SCENARIO_COUNT = 7;

const RESULTS: Record<string, Result> = { pass: "pass", fail: "fail" };

function scenariosOf(progress: Record<string, string>): Scenario[] {
  const ids = Object.keys(progress)
    .map((key) => /^S(\d+)_TITLE$/.exec(key)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  return ids.map((id) => ({
    id,
    title: progress[`S${id}_TITLE`]!,
    result: RESULTS[progress[`S${id}_RESULT`] ?? ""] ?? "skipped", // no answer is not a pass
    note: progress[`S${id}_NOTE`] ?? "",
  }));
}

function doctorOf(text: string | undefined): Report["doctor"] {
  if (text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; checks?: unknown };
    if (!Array.isArray(parsed.checks)) return null;
    const checks = (parsed.checks as DoctorCheck[]).map(({ id, status, message, hint }) => ({ id, status, message, ...(hint ? { hint } : {}) }));
    return { ok: parsed.ok === true, checks };
  } catch {
    return null;
  }
}

function kitVersion(kitDir: string | undefined): string | null {
  if (!kitDir) return null;
  try {
    return (JSON.parse(readFileSync(join(kitDir, "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function buildReport(progress: Record<string, string>, doctorText: string | undefined, kitDir: string | undefined, now = new Date()): Report {
  const scenarios = scenariosOf(progress);
  const count = (result: Result) => scenarios.filter((s) => s.result === result).length;
  const pass = count("pass");
  return {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    kit: { version: kitVersion(kitDir) },
    environment: {
      platform: process.platform,
      osRelease: release(),
      wsl: release().toLowerCase().includes("microsoft"),
      node: process.version,
      cursorVersion: progress.CURSOR_VERSION || null,
      ideTerminal: progress.IDE_TERMINAL === "yes",
    },
    doctor: doctorOf(doctorText),
    scenarios,
    summary: { pass, fail: count("fail"), skipped: count("skipped"), releaseCriterionMet: scenarios.length === SCENARIO_COUNT && pass === SCENARIO_COUNT },
  };
}

function issueTitle(report: Report): string {
  const { pass, fail, skipped } = report.summary;
  return [`Cursor IDE validation: ${pass} of ${SCENARIO_COUNT} scenarios passed`, ...(fail ? [`${fail} failed`] : []), ...(skipped ? [`${skipped} not run`] : [])].join(", ");
}

/** A table cell: one line, and a `|` that cannot close the cell. */
const cell = (text: string) => text.replace(/\r?\n/g, "; ").replace(/\|/g, "\\|");

function issueBody(report: Report): string {
  const { environment: env, doctor, scenarios, summary } = report;
  const lines = [
    "## Cursor IDE validation",
    "",
    `${issueTitle(report)}. The release criterion (all scenarios pass) is ${summary.releaseCriterionMet ? "met" : "not met"}.`,
    "",
    "| # | Scenario | Result | Note |",
    "|---|---|---|---|",
    ...scenarios.map((s) => `| ${s.id} | ${cell(s.title)} | ${s.result} | ${cell(s.note)} |`),
    "",
    "### Environment",
    "",
    `- Kit: ${report.kit.version ?? "unknown"}`,
    `- OS: ${env.platform} ${env.osRelease}${env.wsl ? " (WSL)" : ""}`,
    `- Node: ${env.node}`,
    `- Cursor: ${env.cursorVersion ?? "not given"}`,
    `- Wizard terminal: ${env.ideTerminal ? "inside Cursor" : "outside Cursor"}`,
    "",
    "### wf doctor",
    "",
  ];
  if (doctor) {
    lines.push(`${doctor.ok ? "All checks passed." : "At least one check failed."}`, "", "| Check | Status | Message |", "|---|---|---|", ...doctor.checks.map((c) => `| ${cell(c.id)} | ${cell(c.status)} | ${cell(c.message)} |`));
  } else {
    lines.push("No doctor report was recorded.");
  }
  lines.push("", "---", "Filed by `scripts/verify/validate-cursor-ide.sh`. Local paths, repository names and accounts are anonymized.", "");
  return lines.join("\n");
}

function main(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { progress: { type: "string" }, "out-dir": { type: "string" }, doctor: { type: "string" }, kit: { type: "string" } } });
  if (!values.progress || !values["out-dir"]) {
    process.stderr.write("validation-report: --progress <file> and --out-dir <dir> are required\n");
    return 2;
  }
  const progress = parseProgress(readFileSync(values.progress, "utf8"));
  const kitDir = values.kit ? resolve(values.kit) : undefined;
  const anonymize = anonymizer({
    sandboxRepo: progress.SANDBOX_REPO,
    sandboxDir: progress.SANDBOX_DIR,
    kitDir,
    home: homedir(),
    user: userInfo().username,
    host: hostname(),
  });
  const report = anonymizeFreeText(buildReport(progress, values.doctor ? readFileSync(values.doctor, "utf8") : undefined, kitDir), anonymize);
  const dir = resolve(values["out-dir"]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "issue-body.md"), issueBody(report));
  process.stdout.write(`${issueTitle(report)}\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
