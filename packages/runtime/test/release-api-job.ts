// Child process of install.process.test.ts: a stand-in for the GitHub releases API, which the installer and `wf upgrade` ask
// whether a release is immutable (`GET /repos/<owner>/<repo>/releases/tags/<tag>`). The test process blocks in `spawnSync`
// while the installer runs, so the server has to live in a process of its own.
// Usage: release-api-job.ts <dir>. It prints `port <n>` on stdout once it listens, and stays until killed.
//
// It answers from the recordings of the real API (fixtures/github-releases/recordings.json, made by
// scripts/verify/record-release-fixtures.ts), and the test sets on them only the fields it controls. The test steers it through
// files in <dir>, because it cannot talk to a server it blocks on:
//   <tag>.json   `{ "immutable": true | false | null }` sets that field of the recorded release (null leaves the field out), and
//                `{ "release": "missing" }` answers the recorded 404 of a tag with no release; without the file, immutable is true
// Every request path is appended to <dir>/requests.log, one per line, so a test can read what was asked. A path that is not a
// release lookup gets the recorded 404, as GitHub answers a route it does not have.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ReleaseRecordingsFile } from "../../../scripts/verify/record-release-fixtures.js";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: release-api-job.ts <dir>");

const { release, "no-release": noRelease } = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "github-releases", "recordings.json"), "utf8")) as ReleaseRecordingsFile).recordings;

const server = createServer((req, res) => {
  const path = req.url ?? "";
  appendFileSync(join(dir, "requests.log"), `${path}\n`);
  const tag = /^\/repos\/[\w.-]+\/[\w.-]+\/releases\/tags\/([\w.-]+)$/.exec(path)?.[1];
  const controls = tag !== undefined && existsSync(join(dir, `${tag}.json`)) ? (JSON.parse(readFileSync(join(dir, `${tag}.json`), "utf8")) as { immutable?: boolean | null; release?: string }) : {};
  if (tag === undefined || controls.release === "missing") {
    res.writeHead(noRelease.status, { "content-type": "application/json" }).end(JSON.stringify(noRelease.body));
    return;
  }
  const body: Record<string, unknown> = { ...release.body, tag_name: tag, immutable: controls.immutable === undefined ? true : controls.immutable };
  if (body.immutable === null) delete body.immutable;
  res.writeHead(release.status, { "content-type": "application/json" }).end(JSON.stringify(body));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`port ${typeof address === "object" && address !== null ? address.port : 0}\n`);
});
