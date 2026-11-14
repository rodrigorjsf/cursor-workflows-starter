// Seam: HTTP, with stand-ins for the `gh` and `glab` CLIs. A card can link to a GitHub pull request or a GitLab merge request, and
// the Board shows the state of it (open, merged, closed). The dashboard asks `gh` or `glab` for it, never more often than a
// short-lived cache allows, and never makes the Board wait for it: a state not known yet shows up on a later poll.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type DashboardServer, startDashboard } from "../src/server.js";
import { type FakeGh, type FakeGlab, type Sandbox, fakeGh, fakeGlab, glabConfigOf, http, sandbox, writeRun } from "./support.js";

let box: Sandbox;
let gh: FakeGh;
let glab: FakeGlab;
let dash: DashboardServer | undefined;
beforeEach(() => {
  box = sandbox();
  gh = fakeGh(box);
  glab = fakeGlab(box);
});
afterEach(async () => {
  await dash?.close();
  dash = undefined;
  glab.restore(); // before gh: each puts back the PATH it found
  gh.restore();
  box.dispose();
});

const T0 = Date.parse("2026-01-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const PR = (n: number) => `https://github.com/acme/widgets/pull/${n}`;
const MR = (n: number, host = "gitlab.com", project = "acme/widgets") => `https://${host}/${project}/-/merge_requests/${n}`;

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

test("a link to a GitLab merge request on gitlab.com carries its state: open, merged or closed, and a locked one (being merged) is open", async () => {
  dash = await startDashboard({ port: 0 });
  glab.set(MR(1), "opened");
  glab.set(MR(2), "merged");
  glab.set(MR(3), "closed");
  glab.set(MR(4), "locked");
  runWithLinks("implement-issue-aaaa0001", 0, [MR(1), MR(2)]);
  runWithLinks("implement-issue-bbbb0002", 1, [MR(3), MR(4)]);

  const states = await until(
    "the four states arrive",
    async () => [
      await stateOf("implement-issue-aaaa0001", MR(1)),
      await stateOf("implement-issue-aaaa0001", MR(2)),
      await stateOf("implement-issue-bbbb0002", MR(3)),
      await stateOf("implement-issue-bbbb0002", MR(4)),
    ],
    (s) => s.every(Boolean),
  );
  assert.deepEqual(states, ["open", "merged", "closed", "open"]);
  assert.deepEqual(
    glab.calls().map((c) => c.join(" ")).sort(),
    [1, 2, 3, 4].map((n) => `api --hostname gitlab.com projects/acme%2Fwidgets/merge_requests/${n}`),
    "glab was asked through its REST API, one merge request at a time, never through `glab mr view <url>`, which needs a GitLab checkout",
  );
  assert.deepEqual(gh.calls(), [], "gh was not asked about a GitLab link");
});

test("a merge request on a host glab is logged in to has a state; the same merge request on a host glab does not know has none and is never asked about", async () => {
  dash = await startDashboard({ port: 0 });
  glab.config(glabConfigOf({ "gitlab.com": "glpat-DOTCOM", "git.example.com": "glpat-SELFMANAGED" }));
  const known = MR(5, "git.example.com", "platform/tools/widgets");
  const unknown = MR(5, "other.example.org", "platform/tools/widgets");
  glab.set(known, "merged");
  glab.set(unknown, "merged"); // the fake would answer: it is the dashboard that must not ask
  runWithLinks("implement-issue-aaaa0001", 0, [known, unknown]);

  assert.equal(await until("the state arrives", () => stateOf("implement-issue-aaaa0001", known), Boolean), "merged");
  await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a wrong ask to show up
  assert.equal(await stateOf("implement-issue-aaaa0001", unknown), undefined);
  assert.deepEqual(glab.calls(), [["api", "--hostname", "git.example.com", "projects/platform%2Ftools%2Fwidgets/merge_requests/5"]], "glab was started once, for the host of its own config");
});

test("only a merge request of an allowed host is asked about, and only by its exact url: no other host, no extra path, query, fragment or option, no http, no issue, no malformed number", async () => {
  dash = await startDashboard({ port: 0 });
  glab.config(glabConfigOf({ "git.example.com": "glpat-SELFMANAGED", "github.com": "glpat-WRONG" })); // github.com is GitHub, whatever glab's config says
  glab.set(MR(1), "opened");
  const notMrs = [
    "https://evil.example/acme/widgets/-/merge_requests/1",
    "https://gitlab.com.evil.example/acme/widgets/-/merge_requests/1",
    "https://GitLab.com/acme/widgets/-/merge_requests/1",
    "https://user:secret@gitlab.com/acme/widgets/-/merge_requests/1",
    "http://gitlab.com/acme/widgets/-/merge_requests/1",
    "https://gitlab.com/acme/widgets/-/merge_requests/1/diffs",
    "https://gitlab.com/acme/widgets/-/merge_requests/1?x=1",
    "https://gitlab.com/acme/widgets/-/merge_requests/1#note_5",
    "https://gitlab.com/acme/widgets/-/issues/1",
    "https://gitlab.com/acme/widgets/-/merge_requests/one",
    "https://gitlab.com/acme/widgets/-/merge_requests/1234567890",
    "https://gitlab.com/acme/widgets/-/merge_requests/",
    "https://gitlab.com/widgets/-/merge_requests/1",
    "https://gitlab.com/-/merge_requests/1",
    "https://gitlab.com/acme/../widgets/-/merge_requests/1",
    "https://gitlab.com/acme/widgets/merge_requests/1",
    "https://github.com/acme/widgets/-/merge_requests/1",
    "https://-oops.example.com/acme/widgets/-/merge_requests/1",
    "https://git.example.com/acme/widgets/-/merge_requests/1/",
  ];
  for (const url of notMrs) glab.set(url, "opened"); // the fake would answer for each: it is the dashboard that must not ask
  // A card keeps at most 8 links: the real merge request is on the first card, the others are spread over more.
  const cards = ["implement-issue-aaaa0001", "implement-issue-bbbb0002", "implement-issue-cccc0003"];
  runWithLinks(cards[0]!, 0, [MR(1), ...notMrs.slice(0, 7)]);
  runWithLinks(cards[1]!, 1, notMrs.slice(7, 14));
  runWithLinks(cards[2]!, 2, notMrs.slice(14));
  await until("the real merge request is answered", () => stateOf(cards[0]!, MR(1)), Boolean);
  await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a wrong ask to show up
  const links = (await Promise.all(cards.map(linksOf))).flat();
  assert.equal(links.length, 1 + notMrs.length, "every link is on the Board");
  assert.deepEqual(links.filter((l) => l.state).map((l) => l.url), [MR(1)]);
  assert.deepEqual(glab.calls(), [["api", "--hostname", "gitlab.com", "projects/acme%2Fwidgets/merge_requests/1"]], "glab was started once, for the one merge request, with a fixed argument list");
  assert.deepEqual(gh.calls(), [], "gh was not asked about a link that is not a pull request of github.com");
});

test("the tokens of glab's config appear nowhere: not on the Board, not in the pages, not on the command line glab is started with, not in what the dashboard prints", async () => {
  const tokens = { "gitlab.com": "glpat-DOTCOM-0123456789", "git.example.com": "glpat-SELFMANAGED-9876543210" };
  glab.config(glabConfigOf(tokens));
  const printed: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const capture = (real: typeof process.stdout.write) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      printed.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (real as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = capture(realOut);
  process.stderr.write = capture(realErr);
  const seen: string[] = [];
  try {
    dash = await startDashboard({ port: 0 });
    const onSelfManaged = MR(2, "git.example.com");
    glab.set(MR(1), "opened");
    glab.set(onSelfManaged, "merged");
    runWithLinks("implement-issue-aaaa0001", 0, [MR(1), onSelfManaged]);
    await until("both states arrive", async () => [await stateOf("implement-issue-aaaa0001", MR(1)), await stateOf("implement-issue-aaaa0001", onSelfManaged)], (s) => s.every(Boolean));
    for (const path of ["/", "/api/board", "/api/runs", "/api/summary", "/api/csrf"]) seen.push((await http(dash.url, path)).text);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  seen.push(JSON.stringify(glab.calls()), ...printed);
  for (const token of Object.values(tokens)) assert.ok(seen.every((text) => !text.includes(token)), `${token} leaked`);
  assert.ok(seen.every((text) => !text.includes("config.yml")), "the config file is not named either");
});

test("the Board does not wait for GitLab either: the first answer has the merge request link without a state, a later one has it", async () => {
  dash = await startDashboard({ port: 0 });
  glab.set(MR(1), "opened");
  runWithLinks("implement-issue-aaaa0001", 0, [MR(1)]);
  const first = await linksOf("implement-issue-aaaa0001");
  assert.deepEqual(first, [{ label: "link 0", url: MR(1) }], "the link is there at once, with no state yet");
  assert.equal(await until("the state arrives", () => stateOf("implement-issue-aaaa0001", MR(1)), Boolean), "open");
});

test("a GitLab state is cached: polling the Board again and again asks glab once per merge request; an open one is asked again once its answer is old, a merged one is kept much longer", async () => {
  dash = await startDashboard({ port: 0, prStateCacheMs: 40 }); // open: 40 ms; settled: 120 times that
  glab.set(MR(1), "opened");
  glab.set(MR(2), "merged");
  runWithLinks("implement-issue-aaaa0001", 0, [MR(1), MR(2)]);
  runWithLinks("implement-issue-bbbb0002", 1, [MR(1)]); // two cards, one merge request
  await until("both states arrive", async () => [await stateOf("implement-issue-aaaa0001", MR(1)), await stateOf("implement-issue-aaaa0001", MR(2))], (s) => s.every(Boolean));

  glab.set(MR(1), "merged"); // on GitLab, the open one is merged
  assert.equal(await until("the merge is seen", () => stateOf("implement-issue-aaaa0001", MR(1)), (s) => s === "merged"), "merged");
  const askedAbout = (n: number) => glab.calls().filter((c) => c[3]!.endsWith(`/merge_requests/${n}`)).length;
  assert.ok(askedAbout(1) >= 2, "the open merge request was asked about again");
  assert.equal(askedAbout(2), 1, "the merged one was not");
  // While an old answer is refreshed the Board keeps showing it.
  for (let i = 0; i < 10; i++) {
    assert.equal(await stateOf("implement-issue-aaaa0001", MR(2)), "merged", `poll ${i}`);
    await new Promise((r) => setTimeout(r, 15));
  }
});

test("a merge request glab cannot answer for has no state, the Board still answers, and the failure is not retried on every poll", async () => {
  dash = await startDashboard({ port: 0 });
  runWithLinks("implement-issue-aaaa0001", 0, [MR(7)]); // the fake knows no such merge request: exit 1
  for (let i = 0; i < 5; i++) {
    assert.equal((await http(dash.url, "/api/board")).status, 200);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(await stateOf("implement-issue-aaaa0001", MR(7)), undefined);
  assert.equal(glab.calls().length, 1, "one try, then the failure is remembered");
});

test("with no glab installed at all the Board works and the links have no state", async () => {
  glab.restore();
  gh.restore();
  const previous = process.env.PATH;
  process.env.PATH = box.repo("empty-bin"); // no glab anywhere
  try {
    dash = await startDashboard({ port: 0 });
    runWithLinks("implement-issue-aaaa0001", 0, [MR(1)]);
    assert.equal((await http(dash.url, "/api/board")).status, 200);
    await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a state to show up, which must not
    assert.equal(await stateOf("implement-issue-aaaa0001", MR(1)), undefined);
  } finally {
    process.env.PATH = previous;
  }
});

test("glab's config is read for host names only, however it spells them: plain, quoted, with a port, with a comment, with CRLF lines; a host that is only a value or a nested key is no host", async () => {
  dash = await startDashboard({ port: 0 });
  glab.config(
    [
      "# glab's own comment",
      "host: gitlab.com",
      "hosts:",
      "    a.example.com:",
      "        token: glpat-A",
      "        api_host: d.example.com",
      '    "b.example.com:8443":   # a port',
      "        token: glpat-B",
      "    'C.Example.com':",
      "        token: glpat-C",
      "    e.example.com:8444:",
      "        token: glpat-E",
      "        f.example.com:",
      "            token: glpat-F",
      "git_protocol: ssh",
      "f.example.com:",
      "    token: glpat-G",
      "",
    ].join("\r\n"),
  );
  const hosts = ["a.example.com", "b.example.com:8443", "c.example.com", "e.example.com:8444", "d.example.com", "f.example.com", "g.example.com"];
  hosts.forEach((host, i) => glab.set(MR(i + 1, host), "opened"));
  runWithLinks("implement-issue-aaaa0001", 0, hosts.map((host, i) => MR(i + 1, host)));
  await until("the host names of the config are answered", async () => (await linksOf("implement-issue-aaaa0001")).filter((l) => l.state).length, (n) => n === 4);
  await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a wrong ask to show up
  const answered = (await linksOf("implement-issue-aaaa0001")).filter((l) => l.state).map((l) => new URL(l.url).host);
  assert.deepEqual(answered, ["a.example.com", "b.example.com:8443", "c.example.com", "e.example.com:8444"]);
});

test("glab's config is read again on every ask: a host the user logs in to while the dashboard runs gets its states", async () => {
  dash = await startDashboard({ port: 0, prStateCacheMs: 20 }); // a failed ask is retried after 10 times that
  const url = MR(1, "git.example.com");
  glab.set(url, "opened");
  runWithLinks("implement-issue-aaaa0001", 0, [url]);
  await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a state to show up, which must not: glab knows no such host yet
  assert.equal(await stateOf("implement-issue-aaaa0001", url), undefined);
  glab.config(glabConfigOf({ "git.example.com": "glpat-SELFMANAGED" })); // `glab auth login --hostname git.example.com`
  assert.equal(await until("the state arrives", () => stateOf("implement-issue-aaaa0001", url), Boolean), "open");
});

test("glab's config is found where glab looks: GLAB_CONFIG_DIR alone when it is set, else ~/.config/glab-cli, else $XDG_CONFIG_HOME/glab-cli", async () => {
  dash = await startDashboard({ port: 0, prStateCacheMs: 20 }); // a failed ask is retried after 10 times that
  const env = { GLAB_CONFIG_DIR: process.env.GLAB_CONFIG_DIR, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = box.repo("a-home");
  const xdg = box.repo("an-xdg-config-home");
  const dir = box.repo("a-glab-config-dir");
  const configOf = (base: string, host: string) => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "config.yml"), glabConfigOf({ [host]: "glpat-X" }));
  };
  /** A card that links to a merge request on `host`, and how to read the state of that link. */
  const watch = (host: string, n: number) => {
    const url = MR(1, host);
    const runId = `implement-issue-aaaa000${n}`;
    glab.set(url, "opened");
    runWithLinks(runId, n, [url]);
    return () => stateOf(runId, url);
  };
  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    configOf(join(home, ".config", "glab-cli"), "home.example.com");
    configOf(join(xdg, "glab-cli"), "xdg.example.com");
    configOf(dir, "dir.example.com");
    const [inHome, inXdg, inDir] = [watch("home.example.com", 1), watch("xdg.example.com", 2), watch("dir.example.com", 3)];

    process.env.GLAB_CONFIG_DIR = dir;
    assert.equal(await until("the directory's host is answered", inDir, Boolean), "open");
    await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a wrong ask to show up
    assert.deepEqual([await inHome(), await inXdg()], [undefined, undefined], "GLAB_CONFIG_DIR alone: no other config is read");

    delete process.env.GLAB_CONFIG_DIR;
    assert.equal(await until("the home's host is answered", inHome, Boolean), "open");
    await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a wrong ask to show up
    assert.equal(await inXdg(), undefined, "the XDG config is not read while the home's is there");

    rmSync(join(home, ".config"), { recursive: true });
    assert.equal(await until("the XDG host is answered", inXdg, Boolean), "open");
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a config file glab cannot read ends the lookup: the next place is not read, and gitlab.com is still answered", async () => {
  dash = await startDashboard({ port: 0, prStateCacheMs: 20 });
  const env = { GLAB_CONFIG_DIR: process.env.GLAB_CONFIG_DIR, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = box.repo("a-home");
  const xdg = box.repo("an-xdg-config-home");
  try {
    delete process.env.GLAB_CONFIG_DIR;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    mkdirSync(join(home, ".config", "glab-cli", "config.yml"), { recursive: true }); // there, but not a file: EISDIR, and glab fails on it too
    mkdirSync(join(xdg, "glab-cli"), { recursive: true });
    writeFileSync(join(xdg, "glab-cli", "config.yml"), glabConfigOf({ "xdg.example.com": "glpat-X" }));
    const control = MR(1);
    const behind = MR(2, "xdg.example.com");
    glab.set(control, "opened");
    glab.set(behind, "opened");
    runWithLinks("implement-issue-aaaa0001", 1, [control, behind]);

    assert.equal(await until("gitlab.com is answered", () => stateOf("implement-issue-aaaa0001", control), Boolean), "open");
    await new Promise((r) => setTimeout(r, 100)); // fixed-wait-ok: time for a wrong ask to show up
    assert.equal(await stateOf("implement-issue-aaaa0001", behind), undefined, "the XDG config is not read past an unreadable one");
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
