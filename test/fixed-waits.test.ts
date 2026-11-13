// Seam: the test files themselves. A test that sleeps a fixed time and then asserts that something asynchronous has happened
// passes on an idle machine and fails on a loaded one (issues #38, #40 and #41 were such flakes). A test waits for a thing by
// polling for it with a deadline: `waitFor` in packages/runtime/test/wait-for.ts. A fixed wait stays only where the time itself
// is the point: proving that something did NOT happen within a window, or letting a clock or a modification time age. Such a
// wait carries the marker on its own line, with the reason after it:
//
//     await sleep(100); // fixed-wait-ok: time for a wrong ask to show up
//
// Wording-keyed: a fixed wait is recognised by its spelling, a statement line that awaits `sleep(...)`, `wait(...)`,
// `delay(...)`, `pause(...)` or `new Promise((r) => setTimeout(r, ...))`, and an assertion by the word `assert` in one of the
// next few lines of the same block. A wait spelled any other way, or an assertion further down, gets through.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const MARKER = /\/\/\s*fixed-wait-ok:\s*\S.{4,}/;
/** An awaited fixed wait that is a statement of its own. */
const FIXED_WAIT = /^\s*await\s+(?:(?:sleep|wait|delay|pause)\([^()]*\)|new Promise\(\s*\(?\w+\)?\s*=>\s*setTimeout\(\s*\w+\s*,[^()]*\)\s*\))\s*;/;
/** How many lines after the wait an assertion still counts as following it. */
const WINDOW = 4;

/** The lines of `text` (1-based) holding a fixed wait that is followed by an assertion and has no marker. */
function unmarkedWaitsBeforeAsserts(text: string): number[] {
  const lines = text.split("\n");
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (!FIXED_WAIT.test(line) || MARKER.test(line)) return;
    const next = lines.slice(i + 1).filter((l) => l.trim() !== "" && !/^\s*\/\//.test(l));
    const block: string[] = [];
    for (const l of next.slice(0, WINDOW)) {
      if (/^\s*[}\])]/.test(l)) break; // the wait's block ends: what comes next does not follow it
      block.push(l);
    }
    if (block.some((l) => /\bassert\b/.test(l))) found.push(i + 1);
  });
  return found;
}

const testFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

const TEST_DIRS = [join(ROOT, "test"), ...readdirSync(join(ROOT, "packages")).map((p) => join(ROOT, "packages", p, "test"))];

test("the check finds a fixed wait followed by an assertion, and lets a marked one, a poll and a wait whose block ends go", () => {
  const sample = [
    "test('beats', async () => {",
    "  const first = read();",
    "  await sleep(300);",
    "  const later = read();",
    "  await done;",
    "  assert.ok(later > first);",
    "  await new Promise((r) => setTimeout(r, 450));",
    "  assert.equal(stats.disposed, 1);",
    "  await wait(150); // fixed-wait-ok: nothing more may arrive in this window",
    "  assert.deepEqual(seen, []);",
    "  for (let i = 0; i < 5; i++) {",
    "    await sleep(10);",
    "  }",
    "  assert.ok(true);",
    "});",
  ].join("\n");
  assert.deepEqual(unmarkedWaitsBeforeAsserts(sample), [3, 7]);
});

test("no test sleeps a fixed time and then asserts: it polls with waitFor, or marks the wait with `// fixed-wait-ok: <reason>`", () => {
  const offences = TEST_DIRS.flatMap((dir) => testFiles(dir)).flatMap((file) =>
    unmarkedWaitsBeforeAsserts(readFileSync(file, "utf8")).map((line) => `${relative(ROOT, file)}:${line}`),
  );
  assert.ok(TEST_DIRS.length >= 3, `the test folders: ${TEST_DIRS.join(", ")}`);
  assert.deepEqual(
    offences,
    [],
    "a fixed wait followed by an assertion fails on a loaded machine. Poll the condition with waitFor (packages/runtime/test/wait-for.ts); " +
      "if the wait proves that something did NOT happen, or lets a clock age, end its line with `// fixed-wait-ok: <reason>`",
  );
});
