// Seam: the repository's own files, read as text the way a reviewer reads them. The recordings of GitHub's releases API that the
// installer's fake releases API plays (packages/runtime/test/fixtures/github-releases/recordings.json) are read from disk: they
// hold the field the installer and `wf upgrade` test and the 404 of a tag with no release, and no repository, owner or credential
// of the machine that recorded them. GitHub is not here: running it is the recorder's job (scripts/verify/record-release-fixtures.ts),
// which stays out of `npm run check` and CI.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { OWNER_PLACEHOLDER, REPO_PLACEHOLDER, type ReleaseRecordingsFile } from "../scripts/verify/record-release-fixtures.js";
import { leaksWithoutSecrets } from "../scripts/lib/scrub-recording.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const RECORDINGS = "packages/runtime/test/fixtures/github-releases/recordings.json";

test("the recordings hold an immutable release, with the immutable field the installer tests, and the 404 of a tag with no release", () => {
  const { recordings } = JSON.parse(read(RECORDINGS)) as ReleaseRecordingsFile;
  assert.equal(recordings.release.status, 200);
  assert.equal(recordings.release.body.immutable, true, "scripts/install.sh and packages/runtime/src/upgrade.ts read this field");
  assert.match(recordings.release.path, new RegExp(`^/repos/${REPO_PLACEHOLDER}/releases/tags/v\\d+\\.\\d+\\.\\d+$`), "the path the installer asks, with the placeholder repository");
  assert.equal(recordings["no-release"].status, 404);
  assert.equal(recordings["no-release"].body.message, "Not Found");
});

test("the recordings name no repository or owner of the machine that recorded them, and no credential", () => {
  const text = read(RECORDINGS);
  assert.deepEqual(leaksWithoutSecrets(text), []);
  const addresses = [...text.matchAll(/https:\/\/(?:api\.|uploads\.)?github\.com\/(?:repos\/)?([^/"]+(?:\/[^/"]+)?)/g)].map((m) => m[1]!.replace(/\/(releases|tarball|zipball).*$/, ""));
  assert.ok(addresses.length > 0);
  for (const address of new Set(addresses)) assert.ok([REPO_PLACEHOLDER, OWNER_PLACEHOLDER, `users/${OWNER_PLACEHOLDER}`].includes(address) || address.startsWith(`${OWNER_PLACEHOLDER}/`), `unexpected address ${address}`);
});

test("the recorder is not run by npm run check, by any package script or by CI: it needs the network and a real repository", () => {
  const manifests = ["package.json", ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/package.json`)].filter((rel) => existsSync(join(ROOT, rel)));
  const workflows = readdirSync(join(ROOT, ".github", "workflows")).map((name) => `.github/workflows/${name}`);
  for (const rel of [...manifests, ...workflows]) assert.ok(!/record-release-fixtures/.test(read(rel)), `${rel} must not run the real-GitHub recorder`);
});
