// Seam: HTTP, with a stand-in for the `gh` CLI. A card can link to a GitHub pull request, and the Board shows the state of
// that pull request (open, merged, closed). The dashboard asks `gh` for it, never more often than a short-lived cache allows,
// and never makes the Board wait for it: a state not known yet shows up on a later poll.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type FakeGh, type Sandbox, fakeGh, http, sandbox, writeRun } from "./support.js";

let box: Sandbox;
let gh: FakeGh;
let dash: DashboardServer | undefined;
beforeEach(() => {
  box = sandbox();
  gh = fakeGh(box);
});
afterEach(async () => {
  await dash?.close();
  dash = undefined;
  gh.restore();
  box.dispose();
});

const T0 = Date.parse("2026-01-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const PR = (n: number) => `https://github.com/acme/widgets/pull/${n}`;

/** A finished run of `implement-issue` whose card links to `urls`. */
function runWithLinks(runId: string, minutes: number, urls: string[]): void {
  writeRun(box.home, box.repo("repo"), {
    runId,
    workflow: "implement-issue",
    startedAt: at(minutes),
    events: [
      { type: "card", title: runId, links: urls.map((url, i) => ({ label: `link ${i}`, url })) },
      { type: "run-end", status: "finished", outcomeStatus: "done", result: { status: "done" } },
    ],
  });
}

const linksOf = async (runId: string) => {
  const boards = (await http(dash!.url, "/api/board")).json.boards as any[];
  return boards.flatMap((b) => b.cards).find((c) => c.runId === runId).card.links as Array<{ url: string; state?: string }>;
};
const stateOf = async (runId: string, url: string) => (await linksOf(runId)).find((l) => l.url === url)!.state;

/** Polls the Board until `ok` holds: the states arrive from `gh` in the background, after the answer that asked for them. */
async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let last!: T;
  for (let i = 0; i < 100; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`${what}; last answer: ${JSON.stringify(last)}`);
}

test("a link to a GitHub pull request carries the state of the pull request: open, merged or closed", async () => {
  dash = await startDashboard({ port: 0 });
  gh.set(PR(1), "OPEN");
  gh.set(PR(2), "MERGED");
  gh.set(PR(3), "CLOSED");
  runWithLinks("implement-issue-aaaa0001", 0, [PR(1)]);
  runWithLinks("implement-issue-bbbb0002", 1, [PR(2)]);
  runWithLinks("implement-issue-cccc0003", 2, [PR(3)]);

  const states = await until(
    "the three states arrive",
    async () => [await stateOf("implement-issue-aaaa0001", PR(1)), await stateOf("implement-issue-bbbb0002", PR(2)), await stateOf("implement-issue-cccc0003", PR(3))],
    (s) => s.every(Boolean),
  );
  assert.deepEqual(states, ["open", "merged", "closed"]);
});

test("the Board does not wait for GitHub: the first answer has the link without a state, a later one has it", async () => {
  dash = await startDashboard({ port: 0 });
  gh.set(PR(1), "OPEN");
  runWithLinks("implement-issue-aaaa0001", 0, [PR(1)]);
  const first = await linksOf("implement-issue-aaaa0001");
  assert.deepEqual(first, [{ label: "link 0", url: PR(1) }], "the link is there at once, with no state yet");
  assert.equal(await until("the state arrives", () => stateOf("implement-issue-aaaa0001", PR(1)), Boolean), "open");
});

test("only a pull request of github.com is asked about, and only by its exact url: no other host, no extra path, query or option for gh to take", async () => {
  dash = await startDashboard({ port: 0 });
  gh.set(PR(1), "OPEN");
  const notPrs = [
    "https://example.com/acme/widgets/pull/1",
    "https://github.com.evil.example/acme/widgets/pull/1",
    "http://github.com/acme/widgets/pull/1",
    "https://github.com/acme/widgets/pull/1/files",
    "https://github.com/acme/widgets/pull/1?x=1",
    "https://github.com/acme/widgets/pull/1#c",
    "https://github.com/acme/widgets/issues/1",
    "https://github.com/acme/widgets/pull/one",
    "https://github.com/acme/pull/1",
  ];
  runWithLinks("implement-issue-aaaa0001", 0, [PR(1), ...notPrs.slice(0, 4)]); // a card keeps at most 8 links: the others are on a second card
  runWithLinks("implement-issue-bbbb0002", 1, notPrs.slice(4));
  await until("the real pull request is answered", () => stateOf("implement-issue-aaaa0001", PR(1)), Boolean);
  await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a wrong ask to show up
  const links = [...(await linksOf("implement-issue-aaaa0001")), ...(await linksOf("implement-issue-bbbb0002"))];
  assert.equal(links.length, 1 + notPrs.length, "every link is on the Board");
  assert.deepEqual(links.filter((l) => l.state).map((l) => l.url), [PR(1)]);
  assert.deepEqual(gh.calls(), [["pr", "view", PR(1), "--json", "state", "--jq", ".state"]], "gh was started once, for the one pull request, with a fixed argument list");
});

test("a state is cached: polling the Board again and again asks GitHub once per pull request", async () => {
  dash = await startDashboard({ port: 0 });
  gh.set(PR(1), "OPEN");
  runWithLinks("implement-issue-aaaa0001", 0, [PR(1)]);
  runWithLinks("implement-issue-bbbb0002", 1, [PR(1)]); // two cards, one pull request
  await until("the state arrives", () => stateOf("implement-issue-aaaa0001", PR(1)), Boolean);
  for (let i = 0; i < 10; i++) await http(dash.url, "/api/board");
  assert.equal(gh.calls().length, 1);
});

test("an open pull request is asked about again once its answer is old, so the Board sees the merge; a merged one is kept much longer", async () => {
  dash = await startDashboard({ port: 0, prStateCacheMs: 40 }); // open: 40 ms; settled: 120 times that
  gh.set(PR(1), "OPEN");
  gh.set(PR(2), "MERGED");
  runWithLinks("implement-issue-aaaa0001", 0, [PR(1), PR(2)]);
  await until("both states arrive", async () => [await stateOf("implement-issue-aaaa0001", PR(1)), await stateOf("implement-issue-aaaa0001", PR(2))], (s) => s.every(Boolean));

  gh.set(PR(1), "MERGED"); // on GitHub, the open one is merged
  const merged = await until("the merge is seen", () => stateOf("implement-issue-aaaa0001", PR(1)), (s) => s === "merged");
  assert.equal(merged, "merged");
  const askedAbout = (url: string) => gh.calls().filter((c) => c[2] === url).length;
  assert.ok(askedAbout(PR(1)) >= 2, "the open pull request was asked about again");
  assert.equal(askedAbout(PR(2)), 1, "the merged one was not");
});

test("while the old answer is refreshed the Board keeps showing it: a refresh never blanks a state", async () => {
  dash = await startDashboard({ port: 0, prStateCacheMs: 20 });
  gh.set(PR(1), "OPEN");
  runWithLinks("implement-issue-aaaa0001", 0, [PR(1)]);
  await until("the state arrives", () => stateOf("implement-issue-aaaa0001", PR(1)), Boolean);
  for (let i = 0; i < 20; i++) {
    assert.equal(await stateOf("implement-issue-aaaa0001", PR(1)), "open", `poll ${i}`);
    await new Promise((r) => setTimeout(r, 15));
  }
});

test("a pull request gh cannot answer for has no state, the Board still answers, and the failure is not retried on every poll", async () => {
  dash = await startDashboard({ port: 0 });
  runWithLinks("implement-issue-aaaa0001", 0, [PR(7)]); // the fake knows no such pull request: exit 1
  for (let i = 0; i < 5; i++) {
    assert.equal((await http(dash.url, "/api/board")).status, 200);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(await stateOf("implement-issue-aaaa0001", PR(7)), undefined);
  assert.equal(gh.calls().length, 1, "one try, then the failure is remembered");
});

test("with no gh installed at all the Board works and the links have no state", async () => {
  gh.restore();
  const previous = process.env.PATH;
  process.env.PATH = box.repo("empty-bin"); // no gh anywhere
  try {
    dash = await startDashboard({ port: 0 });
    runWithLinks("implement-issue-aaaa0001", 0, [PR(1)]);
    const reply = await http(dash.url, "/api/board");
    assert.equal(reply.status, 200);
    await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a state to show up, which must not
    assert.equal(await stateOf("implement-issue-aaaa0001", PR(1)), undefined);
  } finally {
    process.env.PATH = previous;
  }
});
