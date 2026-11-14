// Shared by the implement-issue fixture (the fake `glab` of every GitLab test) and doctor.process.test.ts (its `glab auth status`): the
// outputs of the real `glab` 1.130.0 that scripts/verify/gitlab-e2e.sh recorded from a real GitLab CE, read from
// fixtures/glab/recordings.json. Nothing in them is written by hand: to change one, record again (the script's HOW line). The host
// of the GitLab they came from is a placeholder; `recorded` swaps it for the host of the test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Recording, RecordingsFile } from "../../../scripts/verify/record-glab-fixtures.js"; // the recorder owns the format; a type import loads nothing

export type { Recording };

/** The file the fake `glab` reads. It is a path, not a module: the fake runs as a child process of the test. */
export const RECORDINGS_PATH = join(import.meta.dirname, "fixtures", "glab", "recordings.json");

/** The host the fake GitLab of the tests answers for: the `gitlab.com` of a repository whose origin is `https://gitlab.com/owner/repo.git`. */
export const TEST_HOST = "gitlab.com";

const file = JSON.parse(readFileSync(RECORDINGS_PATH, "utf8")) as RecordingsFile;

/** The version of glab the recordings came from: mise.toml pins the same one. */
export const RECORDED_GLAB_VERSION = file.recordedWith.glab;

/**
 * The recording `name`, as the tests' GitLab says it: the recorded GitLab's placeholder host is `gitlab.com`, and a URL on it, which
 * the recording printed as `http://` (it ran on plain http), is the `https://` one of gitlab.com. The fake glab does the same swap
 * (`fill` in implement-issue.fixture.ts), which runs as a process of its own and cannot import this.
 */
export function recorded(name: string): Recording {
  const recording = file.recordings[name];
  if (recording === undefined) throw new Error(`no recording named ${name}: the recordings are ${Object.keys(file.recordings).join(", ")}`);
  const fill = (text: string) => text.split(`http://${file.placeholders.host}`).join(`https://${TEST_HOST}`).split(file.placeholders.host).join(TEST_HOST);
  return { args: recording.args.map(fill), exitCode: recording.exitCode, stdout: fill(recording.stdout), stderr: fill(recording.stderr) };
}
