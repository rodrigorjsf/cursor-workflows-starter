// WHAT: Workflow with one read-only step on a Cursor cloud agent. It leaves an untracked marker file in the repository, has
//   the cloud agent read the marker and package.json and answer as a JSON block, and checks that the snapshot branch the
//   engine pushed for the step is gone from the remote afterwards.
// WHY: Cloud execution rests on facts only the real API can confirm: that a cloud agent starts from a pushed branch name, sees
//   uncommitted and untracked files in the snapshot, ends with a final message the engine can read a JSON block from, and
//   reports usage and cost per run. This measures them instead of assuming them.
// WHEN: On a new account or after an SDK upgrade, and before trusting a team's cloud setup. Needs a Cursor plan with Cloud
//   Agents and a repository whose `origin` is on a code host connected to the account (the sandbox repo of
//   setup-sandbox-repo.sh does).
// HOW: see scripts/verify/README.md ("verify-cloud"): a throwaway global config allows the cloud, then
//   `WORKFLOWS_DIR=scripts/verify npm run wf -- run verify-cloud --cwd <sandbox-repo> --max-tokens 60000 --max-cents 25`.

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineWorkflow } from "../../packages/runtime/src/runtime/workflow.js";

const MARKER_FILE = ".wf-verify-cloud-marker";
const PROBE_SCHEMA = {
  type: "object",
  required: ["marker", "packageName"],
  properties: { marker: { type: "string" }, packageName: { type: "string" } },
};

export default defineWorkflow({
  meta: {
    name: "verify-cloud",
    description: "Verification: one read-only step on a Cursor cloud agent (snapshot with uncommitted files, JSON-block result, usage, cleanup).",
    roles: [{ name: "probe", cloud: "read-only", description: "Reads two files of the snapshot and reports them.", defaults: { model: { id: process.env.WF_VERIFY_MODEL ?? "composer-2.5" } } }],
  },
  defaults: { timeoutMs: 10 * 60_000, retries: 0 },
  async run(ctx) {
    const snapshotBranches = async () => {
      const listed = await ctx.exec("git", ["ls-remote", "--heads", "origin", "wf/cloud-snapshot/*"], { label: "list-snapshot-branches" });
      return listed.ok ? listed.tail.split("\n").filter(Boolean).length : -1;
    };
    const before = await snapshotBranches();
    const token = `marker-${randomUUID()}`;
    const markerPath = join(ctx.cwd, MARKER_FILE);
    await writeFile(markerPath, `${token}\n`); // untracked and not ignored: only a snapshot of the worktree carries it
    let probe: { marker: string; packageName: string };
    try {
      probe = await ctx.agent<{ marker: string; packageName: string }>(
        `Read the file ${MARKER_FILE} and package.json at the repository root. Answer with the exact content of ${MARKER_FILE}, without the line break, as \`marker\`, and the \`name\` field of package.json as \`packageName\`.`,
        { role: "probe", label: "cloud-probe", tools: ["read"], schema: PROBE_SCHEMA },
      );
    } finally {
      await rm(markerPath, { force: true });
    }
    const after = await snapshotBranches();
    const sawUncommittedFile = probe.marker.trim() === token;
    ctx.metric("sawUncommittedFile", sawUncommittedFile ? 1 : 0);
    ctx.metric("snapshotBranchesLeft", after);
    return { status: "done", probe, sawUncommittedFile, snapshotBranches: { before, after } };
  },
});
