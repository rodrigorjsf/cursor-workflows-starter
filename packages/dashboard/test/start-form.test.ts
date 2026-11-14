// Seam: the Start panel as the browser first paints it. `startBody` and `argsTextOf` (app/start-form.ts) are pure functions, and
// `StartPanelView` (app/StartPanel.tsx) is rendered to static markup with its data handed to it: what a reader sees while the
// repositories load, when they failed, when there are none, and when the form is there. No DOM, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StartPanelView, type StartPanelViewProps } from "../app/StartPanel.js";
import { EMPTY_FORM, argsTextOf, startBody } from "../app/start-form.js";
import { render, textOf } from "./render.js";

const FORM = { repo: "/work/web-app", workflow: "echo", argsText: '{\n  "issue": 0\n}', maxTokens: "50000", maxCents: "20" };

test("a form with JSON args and both caps becomes the request the server takes, args as an object and caps as numbers", () => {
  assert.deepEqual(startBody({ ...FORM, argsText: '{ "issue": 7 }', maxCents: "12.5" }), { ok: true, body: { repo: "/work/web-app", workflow: "echo", args: { issue: 7 }, maxTokens: 50_000, maxCents: 12.5 } });
});

test("a cap box left empty leaves the cap out, for the server to refuse by name; text that is not a number is refused here", () => {
  assert.deepEqual(startBody({ ...FORM, maxTokens: "", maxCents: "  " }), { ok: true, body: { repo: "/work/web-app", workflow: "echo", args: { issue: 0 } } });
  assert.deepEqual(startBody({ ...FORM, maxTokens: "lots" }), { ok: false, error: "maxTokens must be a number" });
  assert.deepEqual(startBody({ ...FORM, maxCents: "1,5" }), { ok: false, error: "maxCents must be a number" });
});

test("args that are not JSON, or not an object, are refused with the reason, before anything is sent", () => {
  const syntax = startBody({ ...FORM, argsText: '{ "issue": ' });
  assert.equal(syntax.ok, false);
  assert.match(!syntax.ok ? syntax.error : "", /^the args are not valid JSON: /);
  for (const argsText of ["[1]", "7", "null", '"text"']) assert.deepEqual(startBody({ ...FORM, argsText }), { ok: false, error: "the args must be a JSON object" }, argsText);
});

test("the args box starts with the workflow's skeleton, written one field to a line, or {} when there is no workflow", () => {
  assert.equal(argsTextOf({ name: "echo", description: "", argsSkeleton: { issue: 0, note: "" }, optionalArgs: [] }), '{\n  "issue": 0,\n  "note": ""\n}');
  assert.equal(argsTextOf(undefined), "{}");
  assert.equal(EMPTY_FORM.argsText, "{}");
});

const noop = () => undefined;
const view = (props: Partial<StartPanelViewProps>) =>
  render(StartPanelView, {
    repos: { state: "ready", value: ["/work/web-app", "/work/api"] },
    workflows: {
      state: "ready",
      value: {
        repo: "/work/web-app",
        workflows: [
          { name: "echo", description: "Echoes its args.", whenToUse: "Only in tests.", argsSkeleton: { issue: 0 }, optionalArgs: ["note", "openPr"] },
          { name: "plain", description: "Takes no args.", argsSkeleton: {}, optionalArgs: [] },
        ],
        broken: [],
      },
    },
    form: FORM,
    sending: false,
    onRepo: noop,
    onWorkflow: noop,
    onField: noop,
    onSubmit: noop,
    onClose: noop,
    ...props,
  });

test("the form lists the repositories by folder name, the workflows by name, the args skeleton and both caps as required boxes", () => {
  const html = view({});
  const text = textOf(html);
  assert.match(text, /Start a workflow/);
  for (const name of ["web-app", "api", "echo", "plain"]) assert.match(text, new RegExp(`\\b${name}\\b`), name);
  assert.match(text, /\/work\/web-app/, "the chosen repository's full path is written out, not only in a tooltip");
  assert.match(text, /Only in tests\./, "the chosen workflow says when to use it");
  assert.match(html, /<textarea[^>]*>\{\n {2}&quot;issue&quot;: 0\n\}<\/textarea>/, "the args box holds the skeleton");
  assert.match(html, /Also accepted: <span><code>note<\/code><\/span><span>, <code>openPr<\/code><\/span>\./, "the fields the skeleton leaves out are named");
  assert.equal([...html.matchAll(/<input[^>]*type="number"[^>]*required/g)].length, 2, "both caps are required boxes");
  assert.match(html, /<button[^>]*type="submit"(?![^>]*disabled)[^>]*>Start<\/button>/, "Start is there, and enabled");
  assert.match(html, /<form[^>]*>/);
  assert.doesNotMatch(html, /\bstyle=/, "the app page's policy allows no style attribute");
});

test("while a start is on its way the button says so and waits; a refusal is written out as an alert", () => {
  const sending = view({ sending: true });
  assert.match(sending, /<button[^>]*type="submit"[^>]*disabled[^>]*>Starting…<\/button>/);
  const refused = view({ error: "invalid args: data/issue must be integer" });
  assert.match(refused, /role="alert"[^>]*>invalid args: data\/issue must be integer</);
});

test("before the repositories arrive the panel says it is loading, when they failed it says why, and with none it says how to get one", () => {
  assert.match(view({ repos: { state: "loading" }, workflows: undefined }), /role="status"[^>]*>Loading the repositories…/);
  assert.match(view({ repos: { state: "failed", error: "could not reach the dashboard: fetch failed" }, workflows: undefined }), /role="alert"[^>]*>Could not load the repositories: could not reach the dashboard: fetch failed/);
  const none = textOf(view({ repos: { state: "ready", value: [] }, workflows: undefined, form: EMPTY_FORM }));
  assert.match(none, /No repository to start a workflow in/);
  assert.match(none, /npm run wf -- start <workflow>/);
  const html = view({ repos: { state: "ready", value: [] }, workflows: undefined, form: EMPTY_FORM });
  assert.doesNotMatch(html, /<textarea/, "no form without a repository");
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled/, "and nothing to submit");
});

test("a repository whose workflows are loading, failed to load, or have files that did not load says so next to the form", () => {
  assert.match(view({ workflows: { state: "loading" }, form: { ...FORM, workflow: "" } }), /role="status"[^>]*>Loading the workflows…/);
  assert.match(view({ workflows: { state: "failed", error: "unknown repository: /gone" }, form: { ...FORM, workflow: "" } }), /role="alert"[^>]*>Could not load the workflows: unknown repository: \/gone/);
  const broken = textOf(
    view({ workflows: { state: "ready", value: { repo: "/work/web-app", workflows: [{ name: "plain", description: "d", argsSkeleton: {}, optionalArgs: [] }], broken: [{ file: "/work/web-app/.agents/workflows/bad.ts", error: "SyntaxError" }] } } }),
  );
  assert.match(broken, /1 workflow file of this repository did not load and is not listed: \/work\/web-app\/\.agents\/workflows\/bad\.ts\./);
});
