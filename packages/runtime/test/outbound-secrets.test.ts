// Seam: the text implement-issue sends off the machine. `findSecretInText` (the guard on the staged diff, the seams comment and
// the PR body) and `buildPrBody` (the test output it embeds) are called directly, with fake credentials built at run time.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSecretInText } from "../workflows/implement-issue.js";
import { buildPrBody } from "../workflows/implement-issue/pr-body.js";
import type { SliceRecord } from "../workflows/implement-issue/tdd.js";

const x = (n: number) => "x".repeat(n);
/** One fake sample per credential format the event-log redactor knows and the guard blocks on. */
const BLOCKED: Array<[string, string]> = [
  ["private key", `-----BEGIN RSA PRIVATE KEY-----\n${x(40)}\n-----END RSA PRIVATE KEY-----`],
  ["GitHub fine-grained", `github_pat_${x(30)}`],
  ["GitHub classic", `ghp_${x(36)}`],
  ["GitHub OAuth", `gho_${x(36)}`],
  ["AWS", `AKIA${"X".repeat(16)}`],
  ["sk-", `sk-${x(30)}`],
  ["Cursor", `crsr_${x(40)}`],
  ["Slack", `xoxb-${x(20)}`],
  ["Google", `AIza${x(35)}`],
  ["npm", `npm_${x(36)}`],
  ["Stripe", `sk_live_${x(20)}`],
];

for (const [name, sample] of BLOCKED) {
  test(`the outbound guard blocks a ${name} credential and names only the rule`, () => {
    const rule = findSecretInText(`const k = "${sample}";`, [], {});
    assert.ok(rule, `${name} passed the guard`);
    assert.ok(!rule.includes(sample), "the rule must not repeat the secret");
  });
}

test("the outbound guard keeps the reasons it already gave for Cursor and sk- keys", () => {
  assert.equal(findSecretInText(`crsr_${x(40)}`, [], {}), "Cursor key (crsr_)");
  assert.equal(findSecretInText(`sk-${x(30)}`, [], {}), "sk- key");
  assert.equal(findSecretInText(`k = saved-${x(20)}`, [`saved-${x(20)}`], {}), "the saved SDK key or CURSOR_API_KEY");
});

test("JWT and Bearer shapes, common in test fixtures, are redacted from logs but do not block a delivery", () => {
  const jwt = `eyJ${x(12)}.eyJ${x(12)}.${x(12)}`;
  assert.equal(findSecretInText(`const token = "${jwt}";\nheaders: { Authorization: "Bearer ${x(30)}" }`, [], {}), undefined);
});

test("the value of a secret-named environment variable blocks, and the rule names the variable, not the value", () => {
  const value = `fake-gh-token-${x(20)}`;
  const rule = findSecretInText(`echo ${value}`, [], { GH_TOKEN: value, PATH: "/usr/bin:/bin:/usr/local/bin" });
  assert.ok(rule);
  assert.match(rule, /GH_TOKEN/);
  assert.ok(!rule.includes(value));
  // A short value, or one held in a variable not named like a secret, is not a secret.
  assert.equal(findSecretInText("/usr/bin:/bin:/usr/local/bin", [], { PATH: "/usr/bin:/bin:/usr/local/bin", API_KEY: "short" }), undefined);
});

test("implement-issue declares no credential pattern of its own: the guard uses the redactor's list", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "workflows", "implement-issue.ts"), "utf8");
  assert.doesNotMatch(source, /crsr_\[|sk-\[|gh\[pousr\]/);
});

test("test output embedded in the PR body is redacted, and keeps its local paths replaced", () => {
  const token = `ghp_${x(36)}`;
  const envValue = `fake-npm-token-${x(20)}`;
  const saved = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = envValue;
  try {
    const slice: SliceRecord = {
      key: "k",
      behavior: "subtract",
      seam: "math",
      testName: "subtract",
      testFile: "test/math.test.js",
      red: `not ok 1 - subtract\n  at ${homedir()}/repo/test/math.test.js\n  token=${token}\n  env=${envValue}`,
      green: `ok 1 - subtract (${token})`,
      done: true,
    };
    const body = buildPrBody({ issueNumber: 1, text: { summary: "s", door: "two-way", blastRadius: "local" }, slices: [slice], review: {}, deferred: [] });
    assert.ok(!body.includes(token), "a token printed by a test must not reach the PR");
    assert.ok(!body.includes(envValue), "a secret env value printed by a test must not reach the PR");
    assert.match(body, /\[REDACTED\]/);
    assert.ok(!body.includes(homedir() + "/"), "local paths stay replaced");
    assert.match(body, /~\/repo\/test\/math\.test\.js/);
  } finally {
    if (saved === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = saved;
  }
});
