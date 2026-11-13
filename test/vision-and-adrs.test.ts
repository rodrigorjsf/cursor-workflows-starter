// Seam: the docs book as a reader finds it. Part 1 (vision: the problem, the idea and its references, the concepts),
// the credits and provenance that part 1 absorbed, and part 7 (the ADRs, in English). The mechanical consistency
// of links, anchors, footers and the index is docs-check.test.ts; these tests read what the chapters say.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { test } from "node:test";
import { markdownFiles, parseMarkdown } from "../scripts/lib/markdown.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** The chapters the index lists under `### Parte N`, as `docs/...` paths, in index order. */
function indexPart(number: number): string[] {
  const chapters: string[] = [];
  let inPart = false;
  for (const line of read("docs/README.md").split("\n")) {
    const part = /^### Parte (\d+) · /.exec(line);
    if (part) inPart = Number(part[1]) === number;
    else if (/^##? /.test(line)) inPart = false;
    const entry = /^- \[[^\]]+\]\(([^)#]+)/.exec(line);
    if (inPart && entry) chapters.push(posix.join("docs", entry[1]!));
  }
  return chapters;
}

/** A chapter's prose: fenced code removed, then inline code spans removed. */
function prose(path: string): string {
  return parseMarkdown(read(path)).lines.join("\n").replace(/`[^`\n]*`/g, "");
}

// ---- part 1: the vision ----

test("part 1 has three chapters: the problem, the idea and its references, the concepts", () => {
  assert.deepEqual(indexPart(1), ["docs/vision/01-o-problema.md", "docs/vision/02-a-ideia-e-as-referencias.md", "docs/vision/03-conceitos.md"]);
});

test("the concepts chapter defines workflow, step, role, run, execution, job, frozen, ended, journal, event log and location", () => {
  const entries = [...read("docs/vision/03-conceitos.md").matchAll(/^\*\*([^*\n]+)\*\*/gm)].map((m) => m[1]!.toLowerCase());
  const concepts: Array<[name: string, pattern: RegExp]> = [
    ["workflow", /\bworkflow\b/],
    ["step", /\b(etapa|step)\b/],
    ["role", /\brole\b/],
    ["run", /\brun\b/],
    ["job", /\bjob\b/],
    ["journal", /\bjournal\b/],
    ["event log", /\b(log de eventos|event log)\b/],
    ["location", /\blocation\b/],
    ["execution", /\b(execução|execution)\b/],
    ["frozen", /\b(travado|frozen)\b/],
    ["ended", /\b(terminado|ended)\b/],
  ];
  for (const [name, pattern] of concepts) {
    assert.ok(
      entries.some((entry) => pattern.test(entry)),
      `no glossary entry (a line that starts with a bold term) defines "${name}"; the entries are: ${entries.join(", ")}`,
    );
  }
});

test("the idea chapter names its references and carries the credits and the provenance it absorbed", () => {
  const idea = read("docs/vision/02-a-ideia-e-as-referencias.md");
  // the three references the idea rests on
  assert.match(idea, /\]\(https:\/\/code\.claude\.com\/docs\/en\/workflows/, "the Claude Code Workflow tool");
  assert.match(idea, /\]\(https:\/\/docs\.n8n\.io\//, "n8n");
  assert.match(idea, /\]\(https:\/\/github\.com\/mattpocock\/skills\)/, "the mattpocock skills");
  // what CREDITS.md carried: who the workflow's prompts paraphrase, under which licence
  for (const credited of ["Matt Pocock", "Dex Horthy", "Martin Fowler", "MIT"]) assert.ok(idea.includes(credited), `credits: ${credited}`);
  // what PROVENANCE.md carried: where the kit came from
  for (const origin of ["ai-study-library", "a69f2a2", "81d7356", "session_01FoetnbEHq7GuDkLCZpYC7f", "https://cursor.com/docs/sdk/typescript"]) {
    assert.ok(idea.includes(origin), `provenance: ${origin}`);
  }
});

test("PROVENANCE.md and CREDITS.md live in the book now: the root files are gone and nothing names them", () => {
  assert.ok(!existsSync(join(ROOT, "PROVENANCE.md")), "PROVENANCE.md was absorbed into chapter 1.2");
  assert.ok(!existsSync(join(ROOT, "CREDITS.md")), "CREDITS.md was absorbed into chapter 1.2");

  const stale: string[] = [];
  const files = [...markdownFiles(ROOT), "packages/runtime/workflows/implement-issue.ts", "packages/runtime/workflows/implement-issue/prompts.ts"];
  for (const file of files) {
    if (file === "CHANGELOG.md") continue; // history: 0.1.0 "added PROVENANCE.md" stays as it was written
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (/\b(PROVENANCE|CREDITS)\.md\b/.test(line)) stale.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(stale, [], "these lines still point at a file that no longer exists");
});

// ---- part 7: the ADRs ----

const ADRS: Array<{ file: string; number: string; topic: RegExp[] }> = [
  { file: "docs/adr/0001-layered-config-with-hard-caps.md", number: "0001", topic: [/config/i, /\bcaps?\b/i] },
  { file: "docs/adr/0002-event-log-source-of-truth.md", number: "0002", topic: [/event log/i, /source of truth/i] },
  { file: "docs/adr/0003-detached-jobs.md", number: "0003", topic: [/detached/i, /\bjobs?\b/i] },
  { file: "docs/adr/0004-workspaces-and-claude-md-symlink.md", number: "0004", topic: [/workspaces/i, /CLAUDE\.md/, /symlink/i] },
  { file: "docs/adr/0005-cloud-backend-and-location-cap.md", number: "0005", topic: [/cloud/i, /location/i, /\bcap\b/i] },
  { file: "docs/adr/0006-cloud-steps-as-built.md", number: "0006", topic: [/cloud/i, /read-only/, /fast-forward/i, /supersedes/i] },
  { file: "docs/adr/0007-cancel-stops-cloud-agents.md", number: "0007", topic: [/cloud/i, /read-only/, /fast-forward/i, /supersedes/i, /cancel/i] },
  { file: "docs/adr/0008-job-record-keeps-what-the-log-cannot.md", number: "0008", topic: [/event log/i, /source of truth/i, /job record/i, /killedByCancel/, /supersedes/i] },
];

test("part 7 lists eight ADRs, one per load-bearing decision, in order", () => {
  assert.deepEqual(
    indexPart(7),
    ADRS.map((adr) => adr.file),
  );
});

/** Every ADR on disk, not only the eight: the format below binds the ones added later too. */
const adrFiles = () => readdirSync(join(ROOT, "docs/adr")).filter((name) => /^\d{4}-.*\.md$/.test(name)).map((name) => `docs/adr/${name}`);

test("every ADR is titled ADR-NNNN, names its status and records the context, the decision, the consequences and the options considered", () => {
  assert.ok(adrFiles().length >= ADRS.length, "the eight ADRs are on disk");
  for (const file of adrFiles()) {
    const number = /\/(\d{4})-/.exec(file)![1]!;
    const doc = parseMarkdown(read(file));
    const h1 = doc.headings.find((h) => h.level === 1)?.text ?? "";
    assert.match(h1, new RegExp(`^7\\.\\d+ · ADR-${number}: .+`), `${file}: H1 is the index label "7.N · ADR-${number}: Title"`);

    assert.match(read(file), /^\*\*Status:\*\* (accepted|proposed|superseded by ADR-\d{4})/m, `${file}: a Status line`);
    const sections = doc.headings.filter((h) => h.level === 2).map((h) => h.text);
    for (const section of ["Context", "Decision", "Consequences", "Considered options"]) {
      assert.ok(sections.includes(section), `${file}: section "${section}" (has: ${sections.join(", ")})`);
    }
  }
});

test("each of the eight ADRs is about its decision", () => {
  for (const adr of ADRS) for (const pattern of adr.topic) assert.match(read(adr.file), pattern, `${adr.file}: should be about ${pattern}`);
});

test("the ADRs are written in English", () => {
  const portuguese = /[ãõçáéíóúâêôà]|\b(não|para|uma|que|dos|das|são|também|você|com o|de um)\b/i;
  for (const file of adrFiles()) {
    const found = prose(file)
      .split("\n")
      .filter((line) => !/^\[.*\]\(.*\)$/.test(line.trim()) && line.trim() !== "---") // the book footer is pt-BR navigation
      .filter((line) => portuguese.test(line));
    assert.deepEqual(found, [], `${file} has Portuguese text`);
  }
});

test("ADR-0001 states the caps the installer writes and that the repo and the chat can only tighten them", () => {
  const adr = read("docs/adr/0001-layered-config-with-hard-caps.md");
  assert.match(adr, /code defaults < global < repo < env < flag/i, "the precedence");
  assert.match(adr, /3,000,000 tokens/, "the default per-run token cap");
  assert.match(adr, /600,000 tokens/, "the default per-step token cap");
  assert.match(adr, /500 cents/, "the default cents cap");
  assert.match(adr, /only tighten/i);
  assert.match(adr, /`null`/, "explicit null disables a cap");
});

test("ADR-0005 ties the cloud location to the global cap, the role capability and the repo config's inability to loosen caps", () => {
  const adr = read("docs/adr/0005-cloud-backend-and-location-cap.md");
  assert.match(adr, /allowedLocations/);
  for (const capability of ["ok", "read-only", "never"]) assert.ok(adr.includes(`\`${capability}\``), `capability ${capability}`);
  assert.match(adr, /ADR-0001/, "it builds on the config layering decision");
});

test("a changed decision is a new ADR: ADR-0005 keeps its text and points at ADR-0006, which supersedes it", () => {
  const old = read("docs/adr/0005-cloud-backend-and-location-cap.md");
  assert.match(old, /^\*\*Status:\*\* superseded by ADR-0006/m);
  assert.match(old, /The config resolver rejects `cloud` on a role declared `never`, and cloud writes on a role\s+declared `read-only`/, "the original decision text");
  assert.match(read("docs/adr/0006-cloud-steps-as-built.md"), /^\*\*Status:\*\* superseded by ADR-0007 .*supersedes \[ADR-0005\]/m);
});

test("ADR-0006's lifecycle changed, so ADR-0007 supersedes it: 0006 keeps its text, 0007 states the new cancel and resume rules", () => {
  const old = read("docs/adr/0006-cloud-steps-as-built.md");
  assert.match(old, /^\*\*Status:\*\* superseded by ADR-0007/m);
  assert.match(old, /only a "not found" from the cloud\s+means the agent is gone/, "the original decision text");
  const adr = read("docs/adr/0007-cancel-stops-cloud-agents.md");
  assert.match(adr, /^\*\*Status:\*\* accepted .*supersedes \[ADR-0006\]/m);
  const flat = adr.replace(/\s+/g, " ");
  // the owner's decision (2026-11-12): one rule, whatever state the job is in
  assert.match(flat, /Cancelling a run cancels its cloud agents, whatever state its job is in/);
  for (const state of ["executing", "frozen", "already dead"]) assert.ok(flat.includes(state), `ADR-0007 names the ${state} job`);
  // what the rule costs: the resume that follows pays for a new agent
  assert.match(flat, /newest run was cancelled/, "a resume does not reattach to an agent whose run was cancelled");
  assert.match(flat, /pays (again|for a new agent)/i);
});

test("ADR-0002's job record changed, so ADR-0008 supersedes it: 0002 keeps its text, 0008 names what the record holds beside identity", () => {
  const old = read("docs/adr/0002-event-log-source-of-truth.md");
  assert.match(old, /^\*\*Status:\*\* superseded by ADR-0008/m);
  assert.match(old, /The job\s+record keeps only identity \(job id, run id, pid, heartbeat\)/, "the original decision text");
  const adr = read("docs/adr/0008-job-record-keeps-what-the-log-cannot.md");
  assert.match(adr, /^\*\*Status:\*\* accepted .*supersedes \[ADR-0002\]/m);
  const flat = adr.replace(/\s+/g, " ");
  // what ADR-0002 decided and still holds
  assert.match(flat, /everything else about the run's progress is derived from it/);
  assert.match(flat, /Status is a projection/);
  // the change: identity plus the facts the job's process cannot put in the log, each named
  for (const field of ["start", "refused", "killedByCancel"]) assert.ok(flat.includes(`\`${field}\``), `ADR-0008 names \`${field}\``);
  // killing a frozen job writes nothing in the log: the job stays failed, and only a resume reads the mark
  assert.match(flat, /Killing a frozen job writes nothing in the log/);
  assert.match(flat, /the job stays `failed`/);
  assert.match(flat, /wasKilledByCancel/);
});
