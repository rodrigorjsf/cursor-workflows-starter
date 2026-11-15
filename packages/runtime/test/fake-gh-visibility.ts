// Shared by the cloud tests: a `gh` stand-in on the PATH for the one call a cloud snapshot makes, `gh repo view <url> --json
// visibility -q .visibility` (src/runtime/remote-visibility.ts). It answers from the recordings of the real gh
// (fixtures/gh/recordings.json, recorded by scripts/verify/record-gh-fixtures.ts): the recorded output and exit code for a public
// repository, a private one, and a URL gh cannot answer for. It refuses any other command line, as the real gh would not know it.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { GH_RECORDINGS_PATH, VISIBILITY_RECORDING } from "../../../scripts/verify/record-gh-fixtures.js";

/** What the fake gh says: the visibility of the repository, or that it cannot tell (a host that is not GitHub, no network, no login). */
export type VisibilityAnswer = "PUBLIC" | "PRIVATE" | "unavailable";

const RECORDING_OF: Record<VisibilityAnswer, string> = { PUBLIC: VISIBILITY_RECORDING.public, PRIVATE: VISIBILITY_RECORDING.private, unavailable: VISIBILITY_RECORDING.unavailable };

const FAKE_GH = (recording: string, callsFile: string) => `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs"); // no require: under packages/ an extensionless file is an ES module, and under the system's temp folder a CommonJS one
const recorded = JSON.parse(fs.readFileSync(${JSON.stringify(GH_RECORDINGS_PATH)}, "utf8")).recordings[${JSON.stringify(recording)}];
const argv = process.argv.slice(2);
// the form of the call: the repository's URL is the one argument that is not part of it
const form = (args) => args.map((a, i) => (i === 2 ? "<url>" : a)).join(" ");
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(argv) + "\\n");
if (form(argv) !== form(recorded.args) || !/^https:\\/\\//.test(argv[2] || "")) { process.stderr.write("fake gh: no recording of " + argv.join(" ")); process.exit(2); }
process.stdout.write(recorded.stdout);
process.stderr.write(recorded.stderr);
process.exit(recorded.exitCode);
`;

/** The PATH of this process before the first fake gh. */
let basePath: string | undefined;

/**
 * Puts a `gh` that answers `answer` first on the PATH of this process, with `dir` as its folder. Returns what it was asked (one
 * argument list per call) and how to put the PATH back.
 */
export function fakeVisibilityGh(dir: string, answer: VisibilityAnswer): { asked(): string[][]; restore(): void } {
  basePath ??= process.env.PATH; // the PATH without any fake gh: a test that installs one after another does not stack them
  const bin = join(dir, "fake-gh-bin");
  mkdirSync(bin, { recursive: true });
  const callsFile = join(dir, "fake-gh-calls.jsonl");
  writeFileSync(callsFile, "");
  writeFileSync(join(bin, "gh"), FAKE_GH(RECORDING_OF[answer], callsFile));
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}${delimiter}${basePath ?? ""}`;
  return {
    asked: () => readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    restore: () => void (process.env.PATH = basePath),
  };
}
