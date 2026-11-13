// Seam: the text implement-issue sends to a forge. `sanitizeModelText`, the one door every piece of model text goes through, and
// `buildPrBody`, which puts those pieces into a PR body, are called directly (pure functions, nothing is stubbed). The end-to-end
// case, a run whose seams comment and MR reach a fake glab, is in implement-issue.hardening.test.ts.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrBody, sanitizeModelText } from "../workflows/implement-issue/pr-body.js";

const ZWSP = "​";
const PR_TEXT = { summary: "s", door: "two-way" as const, blastRadius: "local" };

test("a line that starts with a quick action is shown as code, whatever its case and arguments, and only the name is touched", () => {
  assert.equal(sanitizeModelText("/close"), "`/close`");
  assert.equal(sanitizeModelText("/MERGE"), "`/MERGE`");
  assert.equal(sanitizeModelText("/Assign_Reviewer  @bob"), "`/Assign_Reviewer`  @" + ZWSP + "bob");
  assert.equal(sanitizeModelText("done\n/label ~bug\n/estimate 1d\nmore"), `done\n\`/label\` ~${ZWSP}bug\n\`/estimate\` 1d\nmore`);
  assert.equal(sanitizeModelText("/shrug"), "`/shrug`");
});

test("every quick action of GitLab's documentation is known", () => {
  // The names of the "Quick actions" page of GitLab's documentation (18.x), written out by hand, aliases included.
  const documented = `add_child add_contacts add_email approve assign assign_reviewer award blocked_by blocks board_move checkin_reminder
    clear_health_status clear_weight clone close confidential convert_to_ticket copy_metadata create_merge_request done draft due duplicate
    epic estimate estimate_time health_status internal_note iteration label labels link lock merge milestone move page promote_to
    promote_to_incident publish react ready reassign reassign_reviewer rebase relabel relate remove_child remove_contacts remove_due_date
    remove_email remove_estimate remove_iteration remove_label remove_milestone remove_parent remove_reviewer remove_time_estimate
    remove_time_spent remove_zoom reopen request_review reviewer run_pipeline set_parent severity shrug spend spend_time status
    submit_review subscribe tableflip tag target_branch timeline title todo type unapprove unassign unassign_reviewer unlabel unlink
    unlock unsubscribe weight zoom`.split(/\s+/);
  const missed = documented.filter((name) => sanitizeModelText(`/${name} x`) === `/${name} x`);
  assert.deepEqual(missed, []);
});

test("a path, a word that only begins like a quick action and a command not at the start of a line stay as written", () => {
  for (const text of ["/usr/bin/env node", "/tmp", "/etc/hosts", "/closer", "/merge.txt", "/closed now", "  /close", "see /close", "a\n //close", "/"]) {
    assert.equal(sanitizeModelText(text), text, text);
  }
});

test("GitLab drops carriage returns before it looks for a command, so a command behind one is neutralized too", () => {
  assert.equal(sanitizeModelText("ok\r\n/close\r\nok"), "ok\n`/close`\nok");
  assert.equal(sanitizeModelText("ok\n\r/close"), "ok\n`/close`");
});

test("a fenced code block of three backticks is not altered, and what follows it is guarded again", () => {
  const code = "```sh\n/close\n/usr/bin/env node\n!12 ~bug %v1\n```";
  assert.equal(sanitizeModelText(`before\n${code}\n/merge`), `before\n${code}\n\`/merge\``);
});

test("only a fence that every GitLab version reads as code protects its lines: other fence styles and ambiguous closers do not", () => {
  // Tildes, four backticks and an indent are fences to a CommonMark parser, and GitLab's older quick-action regex knows none of them.
  assert.equal(sanitizeModelText("x\n~~~\n/close\n~~~\n/close"), `x\n${ZWSP}~~~\n\`/close\`\n${ZWSP}~~~\n\`/close\``);
  assert.equal(sanitizeModelText("x\n````\n/close\n````"), `x\n${ZWSP}\`\`\`\`\n\`/close\`\n${ZWSP}\`\`\`\``);
  // A closer with trailing space or more than three backticks closes the fence for one parser and not for the other: it is plain text
  // here, so the fence ends at the next bare closer, which both agree on.
  assert.equal(
    sanitizeModelText("x\n```\na\n``` \n````\n```\n/close\n```"),
    `x\n\`\`\`\na\n${ZWSP}\`\`\` \n${ZWSP}\`\`\`\`\n\`\`\`\n\`/close\`\n\`\`\`\n\`\`\`\n`,
  );
});

test("a fence on the first or last line keeps a line break beside it, so the text around the piece cannot join its fence line", () => {
  assert.equal(sanitizeModelText("```\ncode\n```"), "\n```\ncode\n```\n");
  assert.equal(sanitizeModelText("a\n```\ncode\n```"), "a\n```\ncode\n```\n");
});

test("a fence the model leaves open is closed: it cannot reach the next piece of the body, and what is in it is code", () => {
  assert.equal(sanitizeModelText("x\n```sh\n/close"), "x\n```sh\n/close\n```\n");
  assert.equal(sanitizeModelText("```\n```sh\n/close\n```"), "\n```\n```sh\n/close\n```\n"); // an info string does not close it
  assert.equal(sanitizeModelText("x\n~~~~\n/close"), `x\n${ZWSP}~~~~\n\`/close\``); // no tilde fence is trusted, so there is none to close
});

test("a fence left open by one piece cannot turn the code block of the next piece into live text", () => {
  // Read the way a Markdown parser reads the body: a line of 3 backticks opens a fence at column 0 and a bare one closes it.
  const insideFence = (body: string, needle: string) => {
    let open = false;
    for (const line of body.split("\n")) {
      if (/^```[^`]*$/.test(line) && !open) open = true;
      else if (/^```\s*$/.test(line) && open) open = false;
      else if (line === needle) return open;
    }
    return undefined;
  };
  const body = buildPrBody({
    issueNumber: 7,
    text: { ...PR_TEXT, summary: "intro\n```sh\nnever closed", doorNote: "```\n/close\n```" },
    slices: [],
    review: {},
    deferred: [],
  });
  assert.equal(insideFence(body, "/close"), true, body);
  assert.equal((body.match(/^```[^`]*$/gm) ?? []).length % 2, 0, "every fence of the body is closed");
});

test("a fence that an HTML block, a quote or a math block could hide from the parser protects nothing", () => {
  assert.equal(sanitizeModelText("<div>\n```\n\n/close\n```"), "<div>\n```\n\n`/close`\n```\n");
  assert.equal(sanitizeModelText(">>>\n```\n>>>\n/close\n```"), ">>>\n```\n>>>\n`/close`\n```\n");
  assert.equal(sanitizeModelText("$$\n```\n$$\n/close\n```"), "$$\n```\n$$\n`/close`\n```\n");
  // A `<` or `>` inside a fence is code, not a block that hides anything.
  assert.equal(sanitizeModelText("```html\n<div>\n/close\n```"), "\n```html\n<div>\n/close\n```\n");
});

test("a fence GitLab may read differently from this text (indented, in a list item, with a backtick in its info) is plain text, and protects nothing", () => {
  assert.equal(sanitizeModelText("- step\n  ```sh\n/close\n  ```"), `- step\n${ZWSP}  \`\`\`sh\n\`/close\`\n${ZWSP}  \`\`\``);
  assert.equal(sanitizeModelText("x\n```a`b\n/close\n```"), `x\n${ZWSP}\`\`\`a\`b\n\`/close\`\n\`\`\`\n\`\`\`\n`);
});

test("!12, ~label and %milestone, which only GitLab links, get a zero-width space after the sigil; code and ordinary text keep theirs", () => {
  assert.equal(sanitizeModelText("see !12 and group/proj!3"), `see !${ZWSP}12 and group/proj!${ZWSP}3`);
  assert.equal(sanitizeModelText('label ~bug, ~"two words", ~42'), `label ~${ZWSP}bug, ~${ZWSP}"two words", ~${ZWSP}42`);
  assert.equal(sanitizeModelText("due %v1.0 and %5"), `due %${ZWSP}v1.0 and %${ZWSP}5`);
  for (const text of ["a != b", "100% sure", "~/dir and ~ alone", "!important", "~~struck~~", "ok!", "50%"]) assert.equal(sanitizeModelText(text), text, text);
});

test("a closing keyword of GitLab cannot close an issue of another project, whatever the keyword or the reference", () => {
  for (const [text, shown] of [
    ["Closing #5", "Closing `#5`"],
    ["Fixes issue #5", "Fixes `issue #5`"],
    ["closes issues group/p#5", "closes `issues group/p#5`"],
    ["Implements #5", "Implements `#5`"],
    ["fixing: #5", "fixing: `#5`"],
    ["Resolves group/sub/project#5", "Resolves `group/sub/project#5`"],
    ["Closes https://gitlab.example.com/g/sub/p/-/issues/5", "Closes `https://gitlab.example.com/g/sub/p/-/issues/5`"],
    ["Fixed https://gitlab.com/g/p/-/work_items/9", "Fixed `https://gitlab.com/g/p/-/work_items/9`"],
  ] as const) {
    assert.equal(sanitizeModelText(text), shown);
  }
});

test("a list of references after a closing keyword cannot close any of them: GitLab's pattern needs each match to start at the keyword", () => {
  // The pattern is a keyword, then references joined by commas or "and": with a backtick right after the keyword it matches nothing.
  const gitlabCloses = (text: string) => /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?):? +(?:issues? +)?(?:[\w./-]+)?#\d+/i.test(text);
  const text = "Closes #1, #2 and #3, fixes issue #4";
  assert.equal(gitlabCloses(text), true);
  assert.equal(gitlabCloses(sanitizeModelText(text)), false, sanitizeModelText(text));
});

test("the body's own closing line is kept while the model's text around it is neutralized", () => {
  const body = buildPrBody({
    issueNumber: 7,
    text: { ...PR_TEXT, summary: "/close\nCloses #99\nsee !4" },
    slices: [],
    review: {},
    deferred: [],
  });
  assert.ok(body.startsWith("Closes #7\n\n## Summary\n\n`/close`\nCloses `#99`\nsee !" + ZWSP + "4\n"), body);
  const partial = buildPrBody({ issueNumber: 7, text: PR_TEXT, slices: [], review: {}, deferred: ["/merge"] });
  assert.ok(partial.startsWith('Refs #7 (partial delivery: see "Deferred")\n'), partial);
  assert.match(partial, /^- `\/merge`$/m);
});

test("on GitHub the GitLab guard is not applied: fences, lines that start with a slash and GitLab's sigils stay as the model wrote them", () => {
  for (const text of ["- step\n  ```sh\n/close\n  ```", "x\n~~~\n/close\n~~~", "> quote\n```\n/close\n```", "see !12, ~bug and %v1", "```\ncode\n```"]) {
    assert.equal(sanitizeModelText(text, "github"), text, text);
  }
  // What GitHub itself acts on is still neutralized.
  assert.equal(sanitizeModelText("Fixes #12, cc @octocat <!--", "github"), "Fixes `#12`, cc @" + ZWSP + "octocat &lt;!--");
  const body = buildPrBody({ issueNumber: 7, text: { ...PR_TEXT, summary: "- step\n  ```sh\n  /close ~x\n  ```" }, slices: [], review: {}, deferred: [], forge: "github" });
  assert.ok(body.includes("## Summary\n\n- step\n  ```sh\n  /close ~x\n  ```\n"), body);
});
