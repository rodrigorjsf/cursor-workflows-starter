// A snapshot of the working files under a directory, and the way back to it. The engine takes one before a step that can
// write; if the run is cancelled in the middle of that step, the directory is put back as it was, so a resume (which
// runs the step again from its start) never meets half-made edits. A step that asks (`revertOnRetry`) gets the same undo
// before each retry of a failed attempt.
//
// Git is the store and the file lister, never the converter: file contents are hashed and restored byte for byte, with
// no filters (`core.autocrlf`, `.gitattributes` text rules, git-lfs), so a revert cannot change a line ending. The user's
// own state is not disturbed to take a snapshot: nothing is staged, the index is only read, and a file's content is
// written to the object database only when git does not already have those exact bytes.
//
// What a snapshot holds: every file under the directory that git does not ignore (tracked, or untracked and not ignored),
// and the tree of the index. Ignored files are never touched, which is also why `.workflows/` (kept out of git by the
// runtime) is safe.
//
// Limits, by design: a commit the step made stays in the history, a file it wrote outside the directory stays where it
// is, and a file whose name has a line break is not covered.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What git records about a file: the kind and the executable bit, with the hash of its exact bytes. */
interface Entry {
  mode: "100644" | "100755" | "120000";
  /** The git object id of the bytes (for a symlink, of the link's target). */
  blob: string;
}

/** A directory's state at one moment. */
export interface Snapshot {
  /** The directory the step works in. */
  cwd: string;
  /** Every file under `cwd` that git does not ignore, by path relative to `cwd`. */
  files: Map<string, Entry>;
  /** The tree of the git index: what was staged. */
  index: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Runs git with `input` on its standard input and returns what it printed. */
function gitWithInput(cwd: string, args: string[], input: string | Buffer): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise(Buffer.concat(out).toString("utf8")) : reject(new Error(`git ${args[0]} exited with ${code}: ${Buffer.concat(err).toString("utf8").trim()}`))));
    child.stdin!.on("error", () => {}); // git may exit before reading everything; its exit code says why
    child.stdin!.end(input);
  });
}

/** The files under `cwd` that git does not ignore and that exist on disk, with the kind of each. */
async function listFiles(cwd: string): Promise<Array<{ path: string; mode: Entry["mode"] }>> {
  const listed = (await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."])).split("\0").filter(Boolean);
  const files: Array<{ path: string; mode: Entry["mode"] }> = [];
  for (const path of new Set(listed)) {
    if (path.includes("\n")) continue; // cannot go through `hash-object --stdin-paths`
    let stat;
    try {
      stat = lstatSync(join(cwd, path));
    } catch {
      continue; // tracked, but deleted from disk
    }
    if (stat.isSymbolicLink()) files.push({ path, mode: "120000" });
    else if (stat.isFile()) files.push({ path, mode: stat.mode & 0o100 ? "100755" : "100644" });
    // a directory here is a submodule or a nested repository: not ours to snapshot
  }
  return files;
}

/** The object ids of the exact bytes of these files, in order; with `write`, the bytes also go to the object database. */
async function hashFiles(cwd: string, files: Array<{ path: string; mode: Entry["mode"] }>, write: boolean): Promise<string[]> {
  const w = write ? ["-w"] : [];
  const regular = files.filter((f) => f.mode !== "120000");
  const ids = new Map<string, string>();
  if (regular.length) {
    const out = await gitWithInput(cwd, ["hash-object", ...w, "--no-filters", "--stdin-paths"], regular.map((f) => f.path).join("\n") + "\n");
    out.split("\n").filter(Boolean).forEach((id, i) => ids.set(regular[i]!.path, id));
  }
  for (const link of files.filter((f) => f.mode === "120000")) {
    ids.set(link.path, (await gitWithInput(cwd, ["hash-object", ...w, "--stdin"], readlinkSync(join(cwd, link.path)))).trim()); // a link's blob is its target
  }
  return files.map((f) => ids.get(f.path)!);
}

/** Every file under `cwd` as it is now. With `write`, their bytes are also made sure to be in the object database. */
async function manifest(cwd: string, write: boolean): Promise<Map<string, Entry>> {
  const files = await listFiles(cwd);
  const blobs = await hashFiles(cwd, files, false);
  if (write && files.length) {
    // Most files are unchanged and git already has their bytes: only the others are written.
    const checked = (await gitWithInput(cwd, ["cat-file", "--batch-check"], blobs.join("\n") + "\n")).split("\n").filter(Boolean);
    const absent = files.filter((_, i) => checked[i]?.endsWith(" missing"));
    if (absent.length) await hashFiles(cwd, absent, true);
  }
  return new Map(files.map((f, i) => [f.path, { mode: f.mode, blob: blobs[i]! }]));
}

/**
 * Takes a snapshot of `cwd`. Returns undefined when it cannot: `cwd` is not in a git repository, git is missing, or the
 * index is in the middle of a merge. Never changes the files or the index.
 */
export async function takeSnapshot(cwd: string): Promise<Snapshot | undefined> {
  try {
    const index = (await git(cwd, ["write-tree"])).trim();
    return { cwd, files: await manifest(cwd, true), index };
  } catch {
    return undefined;
  }
}

/** Removes the empty directories from `dir` up to (not including) `root`: the ones a file the step created leaves behind. */
function pruneEmptyDirs(root: string, dir: string): void {
  for (let d = dir; d !== root && d.startsWith(root + sep); d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return; // not empty (or already gone)
    }
  }
}

/** Writes `entry` back to `path` (relative to `cwd`): the exact bytes, the executable bit, or the symlink. */
async function restoreFile(cwd: string, path: string, entry: Entry): Promise<void> {
  const target = join(cwd, path);
  const { stdout } = await execFileAsync("git", ["cat-file", "blob", entry.blob], { cwd, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
  rmSync(target, { force: true }); // also what is in the way: a symlink where a file goes, or the reverse
  mkdirSync(dirname(target), { recursive: true });
  if (entry.mode === "120000") {
    symlinkSync(stdout.toString("utf8"), target);
    return;
  }
  writeFileSync(target, stdout);
  if (entry.mode === "100755") chmodSync(target, 0o755);
}

/**
 * Puts the files under `snapshot.cwd` and the index back as they were when the snapshot was taken: the files the step
 * created are deleted (and the directories they leave empty), the ones it changed or deleted are written back. Throws
 * when it cannot; the caller reports that and carries on.
 */
export async function revertToSnapshot(snapshot: Snapshot): Promise<void> {
  const { cwd, files } = snapshot;
  const now = await manifest(cwd, false);
  for (const path of now.keys()) {
    if (files.has(path)) continue;
    rmSync(join(cwd, path), { force: true });
    pruneEmptyDirs(resolve(cwd), dirname(resolve(cwd, path)));
  }
  for (const [path, entry] of files) {
    const current = now.get(path);
    if (current?.blob === entry.blob && current.mode === entry.mode) continue;
    await restoreFile(cwd, path, entry);
  }
  await git(cwd, ["read-tree", snapshot.index]);
}
