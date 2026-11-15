// WHAT: Asks the real GitHub releases API, with no token, what it answers for the release of a tag of the kit's repository
//   (`GET /repos/<owner>/<repo>/releases/tags/<tag>`, whose `immutable` field the installer and `wf upgrade` test) and for a
//   tag that has no release, and writes both answers, with the repository's `owner/name` replaced by `owner/repo` and its owner
//   by `owner`, to packages/runtime/test/fixtures/github-releases/recordings.json. The release notes (`body`) become a
//   placeholder and the author's profile is cut to its type: free text and a person's ids that the check never reads. The fake releases API of the installer's process tests
//   (packages/runtime/test/release-api-job.ts) plays that file. It only reads: nothing is created on GitHub.
// WHY: a fake of an external service answers from a recording of the real one (CODING_STANDARDS, Testing): the fields the
//   check reads and the 404 for a tag with no release are what GitHub sent, never what someone remembered of its documentation.
// WHEN: after changing the lookup in scripts/install.sh or packages/runtime/src/upgrade.ts, or to see whether GitHub changed
//   the release payload. Needs the network and a release of the repository that is immutable.
// HOW: `npx tsx scripts/verify/record-release-fixtures.ts --tag v0.4.0 [--repo <owner/name>]`. Prints where it wrote; exits 2
//   without `--tag`; exits 1 and writes nothing when the release is not immutable, when the tag meant to have no release has
//   one, or when a recording still holds the repository, its owner or a credential.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KIT_REPO } from "../../packages/runtime/src/kit-version.js";
import { errorText } from "../../packages/runtime/src/runtime/error-text.js";
import { createRedactor } from "../../packages/runtime/src/runtime/redaction.js";
import { isEntryPoint } from "../lib/cli.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
/** Where the fake releases API of the installer's process tests reads the recordings. */
export const RELEASE_RECORDINGS_PATH = join(ROOT, "packages", "runtime", "test", "fixtures", "github-releases", "recordings.json");

/** What replaces the repository and its owner the recording was made on. */
export const REPO_PLACEHOLDER = "owner/repo";
export const OWNER_PLACEHOLDER = "owner";
/** What replaces the release notes. */
export const NOTES_PLACEHOLDER = "<release notes>";
/** A tag no release has. */
const NO_RELEASE_TAG = "v0.0.0-no-such-release";
const API = "https://api.github.com";

/** One answer of the API: the path asked, the status, and the JSON body. */
export interface ReleaseRecording {
  path: string;
  status: number;
  body: Record<string, unknown>;
}

/** The file the fake releases API reads. */
export interface ReleaseRecordingsFile {
  recordedFrom: string;
  recordedOn: string;
  placeholders: { repo: string; owner: string };
  recordings: { release: ReleaseRecording; "no-release": ReleaseRecording };
}

/** What the API answers for `GET /repos/<repo>/releases/tags/<tag>`, unauthenticated. */
async function ask(repo: string, tag: string): Promise<ReleaseRecording> {
  const path = `/repos/${repo}/releases/tags/${tag}`;
  const response = await fetch(`${API}${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "cursor-workflows-recorder" }, signal: AbortSignal.timeout(20_000) });
  return { path, status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The recordings of the release of `tag` (which must be immutable) and of a tag with no release, for `repo`, scrubbed. */
export async function record(repo: string, tag: string): Promise<ReleaseRecordingsFile> {
  const owner = repo.split("/")[0] ?? "";
  if (owner === "") throw new Error(`--repo must be <owner/name>; got "${repo}"`);
  const [release, none] = [await ask(repo, tag), await ask(repo, NO_RELEASE_TAG)];
  if (release.status !== 200 || release.body.immutable !== true) throw new Error(`${repo} release ${tag} answered ${release.status} with immutable=${String(release.body.immutable)}: the recording needs a release that is immutable. Nothing was written.`);
  if (none.status !== 404) throw new Error(`${repo} answered ${none.status} for ${NO_RELEASE_TAG}, which should have no release. Nothing was written.`);
  const scrub = <T>(recording: T): T => {
    const text = JSON.stringify(recording).split(repo).join(REPO_PLACEHOLDER).split(owner).join(OWNER_PLACEHOLDER);
    return JSON.parse(createRedactor({ env: {} }).text(text)) as T;
  };
  const author = release.body.author;
  const trimmed = { ...release, body: { ...release.body, body: NOTES_PLACEHOLDER, author: { login: owner, type: typeof author === "object" && author !== null && "type" in author ? author.type : undefined } } };
  const file: ReleaseRecordingsFile = {
    recordedFrom: API,
    recordedOn: new Date().toISOString().slice(0, 10),
    placeholders: { repo: REPO_PLACEHOLDER, owner: OWNER_PLACEHOLDER },
    recordings: { release: scrub(trimmed), "no-release": scrub(none) },
  };
  const text = JSON.stringify(file);
  if (text.includes(repo) || text.includes(owner)) throw new Error("a recording still names the repository or its owner. Nothing was written.");
  return file;
}

/** The whole recording; returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const tag = option("--tag");
  if (tag === undefined) {
    process.stderr.write("usage: record-release-fixtures.ts --tag <tag of an immutable release> [--repo <owner/name>]\n");
    return 2;
  }
  const file = await record(option("--repo") ?? KIT_REPO, tag);
  mkdirSync(dirname(RELEASE_RECORDINGS_PATH), { recursive: true });
  const partial = `${RELEASE_RECORDINGS_PATH}.partial`;
  writeFileSync(partial, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(partial, RELEASE_RECORDINGS_PATH);
  process.stdout.write(`wrote ${RELEASE_RECORDINGS_PATH} (2 recordings, recorded ${file.recordedOn})\n`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${errorText(err)}\n`);
      process.exitCode = 1;
    },
  );
}
