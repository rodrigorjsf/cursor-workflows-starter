// Seam: the Backlog column as the browser first paints it, and the pure functions behind it. `WorkflowBoard` (app/BoardView.tsx) is
// rendered to static markup with its data handed to it; `withBacklogBoard` and `backlogPreset` (app/backlog-board.ts), `choiceAfterListing`
// (app/start-form.ts) and `backlogReply` (src/backlog.ts) are pure functions. No DOM, no network, no forge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Boards, WorkflowBoard } from "../app/BoardView.js";
import { backlogPreset, withBacklogBoard } from "../app/backlog-board.js";
import { choiceAfterListing } from "../app/start-form.js";
import { backlogReply } from "../src/backlog.js";
import type { Board } from "../src/board.js";
import { render, textOf } from "./render.js";

const noop = () => undefined;
const REPLY = {
  workflow: "implement-issue",
  cards: [
    { repo: "/work/web-app", issue: 3, title: "Three <b>bold</b>", url: "https://github.com/owner/repo/issues/3" },
    { repo: "/work/api", issue: 12, title: "Twelve" },
  ],
  errors: [{ repo: "/work/docs", error: "gh issue list exited with code 1: HTTP 502" }],
};
const BOARD: Board = {
  workflow: "implement-issue",
  columns: [
    { key: "phase:Plan", title: "Plan", kind: "phase" },
    { key: "done", title: "Done", kind: "done" },
  ],
  cards: [],
};

test("a board with a Backlog starts with a Backlog column: each card links to its issue, names its repository and has a run button, and a repository's error is on the column", () => {
  const html = render(WorkflowBoard, { board: BOARD, backlog: REPLY, onRun: noop });
  assert.match(html, /<h3><span class="column-title">Backlog<\/span> <span class="count">2<\/span><\/h3>/);
  assert.ok(html.indexOf("Backlog") < html.indexOf("Plan"), "the Backlog is the first column: an issue starts there");
  assert.match(html, /<a class="card-title" href="https:\/\/github.com\/owner\/repo\/issues\/3" target="_blank" rel="noreferrer noopener">#3 Three &lt;b&gt;bold&lt;\/b&gt;<\/a>/, "the title is text, and the link opens the issue");
  assert.match(html, /<span class="card-title">#12 Twelve<\/span>/, "an issue with no address is a title and no link");
  assert.match(html, /<span class="repo" title="\/work\/web-app">web-app<\/span>/);
  assert.equal([...html.matchAll(/<button type="button" class="btn"[^>]*>run<\/button>/g)].length, 2, "one run button a card");
  assert.match(html, /aria-label="Run implement-issue for issue 3"/, "the button says which issue in words");
  assert.match(html, /<p class="banner error" role="alert">docs: gh issue list exited with code 1: HTTP 502<\/p>/);
});

test("a Backlog with only errors is not folded into a strip: its errors are there to read", () => {
  const html = render(WorkflowBoard, { board: BOARD, backlog: { workflow: "implement-issue", cards: [], errors: REPLY.errors }, onRun: noop });
  assert.match(html, /<div class="column column-backlog" role="group" aria-label="Backlog: 0">/);
  assert.match(html, /<div class="column column-phase empty"/, "the columns with no card still fold");
});

test("a board with no Backlog is the board it was: no Backlog column", () => {
  const html = textOf(render(WorkflowBoard, { board: BOARD, onRun: noop }));
  assert.doesNotMatch(html, /Backlog/);
  assert.match(html, /^implement-issue 0 Plan: 0 Plan 0 Done: 0 Done 0$|Plan 0.*Done 0/);
});

test("the Backlog of a workflow with no run yet gets a board of its own, and a workflow that has boards keeps them", () => {
  const smoke: Board = { workflow: "smoke", columns: [], cards: [] };
  assert.deepEqual(withBacklogBoard([smoke], "implement-issue").map((b) => b.workflow), ["smoke", "implement-issue"]);
  assert.deepEqual(withBacklogBoard([smoke, BOARD], "implement-issue"), [smoke, BOARD], "its board exists: nothing is added");
  assert.deepEqual(withBacklogBoard([], "implement-issue"), [{ workflow: "implement-issue", columns: [], cards: [] }]);
});

test("a card's run button opens the Start form for its repository with implement-issue and the issue's number", () => {
  assert.deepEqual(backlogPreset(REPLY.workflow, REPLY.cards[0]!), { repo: "/work/web-app", workflow: "implement-issue", argsText: '{\n  "issue": 3\n}' });
});

test("once a repository's workflows are listed the form takes the preset's workflow and args when the preset is for it, and the first workflow otherwise", () => {
  const listing = [
    { name: "echo", description: "", argsSkeleton: { note: "" }, optionalArgs: [] },
    { name: "implement-issue", description: "", argsSkeleton: { issue: 0 }, optionalArgs: [] },
  ];
  const preset = { repo: "/work/web-app", workflow: "implement-issue", argsText: '{\n  "issue": 3\n}' };
  assert.deepEqual(choiceAfterListing("/work/web-app", listing, preset), { workflow: "implement-issue", argsText: '{\n  "issue": 3\n}' });
  assert.deepEqual(choiceAfterListing("/work/api", listing, preset), { workflow: "echo", argsText: '{\n  "note": ""\n}' }, "a preset for another repository is not applied");
  assert.deepEqual(choiceAfterListing("/work/web-app", [listing[0]!], preset), { workflow: "echo", argsText: '{\n  "note": ""\n}' }, "nor one for a workflow the repository does not list");
  assert.deepEqual(choiceAfterListing("/work/web-app", listing), { workflow: "echo", argsText: '{\n  "note": ""\n}' });
  assert.deepEqual(choiceAfterListing("/work/web-app", []), { workflow: "", argsText: "{}" });
});

test("what the forge printed is not trusted: an issue's address is kept only when it is an http or https one, and an issue with a run is left out", () => {
  const read = (url: string) => ({ repo: "/r", read: { kind: "listed" as const, label: "ready-for-agent", issues: [{ number: 1, title: "t", url }, { number: 2, title: "taken", url: "https://example.com/2" }] }, taken: new Set([2]) });
  assert.deepEqual(backlogReply([read("https://example.com/1")]).cards, [{ repo: "/r", issue: 1, title: "t", url: "https://example.com/1" }]);
  for (const hostile of ["javascript:alert(1)", "data:text/html,<script>1</script>", "not a url", "ftp://example.com/1", ""]) {
    assert.deepEqual(backlogReply([read(hostile)]).cards, [{ repo: "/r", issue: 1, title: "t" }], hostile);
  }
  assert.deepEqual(backlogReply([{ repo: "/r", read: { kind: "failed", error: "no gh" }, taken: new Set() }]), { workflow: "implement-issue", cards: [], errors: [{ repo: "/r", error: "no gh" }] });
});

test("the Boards say the Backlog is loading before its first answer, say why it failed when it did, and show it in front of a board that has no run yet", () => {
  const smoke: Board = { workflow: "smoke", columns: [{ key: "done", title: "Done", kind: "done" }], cards: [] };
  const data = { boards: [smoke] };
  const loading = render(Boards, { data, backlog: {}, onRun: noop });
  assert.match(loading, /<p class="loading" role="status">Loading the Backlog…<\/p>/);
  assert.match(textOf(loading), /smoke/, "the runs do not wait for it");

  const failed = render(Boards, { data, backlog: { error: "/api/backlog answered 500" }, onRun: noop });
  assert.match(failed, /<p class="banner error" role="alert">Could not load the Backlog: \/api\/backlog answered 500<\/p>/);
  assert.doesNotMatch(failed, /Loading the Backlog/);

  const shown = textOf(render(Boards, { data, backlog: { data: REPLY }, onRun: noop }));
  assert.match(shown, /implement-issue 0 Backlog 2/, "the workflow of the Backlog has a board of its own when it has no run");
  assert.ok(shown.indexOf("smoke") < shown.indexOf("implement-issue"), "after the boards of the runs");
  assert.doesNotMatch(shown, /Loading the Backlog/);

  const quiet = textOf(render(Boards, { data: { boards: [] }, backlog: { data: { workflow: "implement-issue", cards: [], errors: [] } }, onRun: noop }));
  assert.match(quiet, /No runs yet/, "a Backlog with nothing to show shows nothing: the board is as it was");
  assert.doesNotMatch(quiet, /Backlog/);
});
