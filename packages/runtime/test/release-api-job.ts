// Child process of install.process.test.ts: a stand-in for the GitHub releases API, which the installer and `wf upgrade`
// ask whether a release is immutable (`GET /repos/<owner>/<repo>/releases/tags/<tag>`). The test process blocks in
// `spawnSync` while the installer runs, so the server has to live in a process of its own.
// Usage: release-api-job.ts <dir>. It prints `port <n>` on stdout once it listens, and stays until killed.
//
// The test steers it through files in <dir>, because it cannot talk to a server it blocks on:
//   <tag>.json    the body to answer for that tag; without it the answer is `{ "tag_name": "<tag>", "immutable": true }`
//   <tag>.status  the HTTP status to answer with, for example 404 for a tag that has no release
// Every request path is appended to <dir>/requests.log, one per line, so a test can read what was asked.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: release-api-job.ts <dir>");

const server = createServer((req, res) => {
  const path = req.url ?? "";
  appendFileSync(join(dir, "requests.log"), `${path}\n`);
  const tag = /^\/repos\/[\w.-]+\/[\w.-]+\/releases\/tags\/([\w.-]+)$/.exec(path)?.[1];
  if (tag === undefined) {
    res.writeHead(400).end();
    return;
  }
  const file = (extension: string) => join(dir, `${tag}.${extension}`);
  const status = existsSync(file("status")) ? Number(readFileSync(file("status"), "utf8")) : 200;
  const body = existsSync(file("json")) ? readFileSync(file("json"), "utf8") : JSON.stringify({ tag_name: tag, immutable: true });
  res.writeHead(status, { "content-type": "application/json" }).end(status === 200 ? body : JSON.stringify({ message: "Not Found" }));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`port ${typeof address === "object" && address !== null ? address.port : 0}\n`);
});
