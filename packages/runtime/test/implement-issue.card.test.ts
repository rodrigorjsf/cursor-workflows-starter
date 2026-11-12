// Seam 1 on the shipped workflow: `implement-issue` puts its issue on the dashboard's Board (`ctx.card`). The card appears once
// the issue is known (after triage), and is updated on delivery with the pull request. Runs `runWorkflow` with the fake SDK and
// the environment of implement-issue.fixture.ts; asserts on the run's event log.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { WorkflowEvent } from "../src/runtime/events.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { branchOf, fx, gh, issue, run, setup, teardown } from "./implement-issue.fixture.js";

beforeEach(setup);
afterEach(teardown);

const eventsOf = (runId: string): WorkflowEvent[] => readEventLog(eventLogPath(fx.repo, runId)).events;
const cardsOf = (events: WorkflowEvent[]) => events.filter((e): e is Extract<WorkflowEvent, { type: "card" }> => e.type === "card");
const shown = ({ title, subtitle, links, badges }: { title: string; subtitle?: string; links?: unknown; badges?: string[] }) => ({ title, subtitle, links, badges });

test("the card shows the issue number and title and the tier as soon as triage is done, before any work starts", async () => {
  issue(["complexity:low"], "Add subtract(a, b)");
  const r = await run({});
  assert.equal(r.status, "finished", JSON.stringify(r.result));
  const events = eventsOf(r.runId);

  const [first] = cardsOf(events);
  assert.deepEqual(shown(first!), { title: "#7 Add subtract(a, b)", subtitle: undefined, links: undefined, badges: ["LOW"] });
  const implementationAt = events.findIndex((e) => e.type === "phase" && e.title === "Implementation");
  assert.ok(events.indexOf(first!) < implementationAt, "the card is on the Board while the work is still ahead of the run");
  assert.ok(events.indexOf(first!) > events.findIndex((e) => e.type === "phase" && e.title === "Triage"), "after the Triage phase began");
});

test("on delivery the card is updated with the pull request and the branch", async () => {
  issue(["complexity:low"], "Add subtract(a, b)");
  const r = await run({ openPr: true });
  assert.equal(r.status, "finished", JSON.stringify(r.result));
  const cards = cardsOf(eventsOf(r.runId));
  assert.equal(cards.length, 2, "one after triage, one on delivery");

  const prUrl = gh().prs[0]!.url;
  assert.deepEqual(shown(cards.at(-1)!), {
    title: "#7 Add subtract(a, b)",
    subtitle: branchOf(r.runId),
    links: [{ label: "PR #1", url: prUrl }],
    badges: ["LOW"],
  });
});

test("a delivery with no pull request still updates the card with the branch, and has no link", async () => {
  issue(["complexity:low"]);
  const r = await run({});
  const last = cardsOf(eventsOf(r.runId)).at(-1)!;
  assert.equal(last.subtitle, branchOf(r.runId));
  assert.equal(last.links, undefined);
});

test("a run that stops after triage leaves the card it set there: the Board still shows the issue", async () => {
  issue(["complexity:medium"]);
  const r = await run({}); // MED proposes the seams and stops, waiting for approval
  assert.equal((r.result as { status: string }).status, "seams-proposed");
  const cards = cardsOf(eventsOf(r.runId));
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0]!.badges, ["MED"]);
});
