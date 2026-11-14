// WHAT: Shared command-line plumbing for the maintainer scripts: which repo root to check (`--root <dir>`, default: the
//   repo this script lives in), whether the file is being run as the entry point, and the write-or `--check` step of a
//   generated docs page.
// WHY: the scripts took their root, ran `main` and wrote or checked their generated page the same way; one copy keeps
//   them alike.
// WHEN: imported by scripts/check-docs.ts, scripts/check-mermaid.ts, scripts/config-reference.ts,
//   scripts/events-reference.ts, scripts/verify/validation-report.ts and scripts/verify/record-glab-fixtures.ts; not run on its own.
// HOW: `const root = rootFromArgs(process.argv.slice(2))`; `if (isEntryPoint(import.meta.url)) process.exitCode = main(...)`;
//   `process.exitCode = writeGeneratedPage({ root, path, page, script, check })`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** `--root <dir>` when given, otherwise the repository root (the parent of scripts/). */
export function rootFromArgs(argv: string[]): string {
  const at = argv.indexOf("--root");
  return at === -1 ? resolve(import.meta.dirname, "..", "..") : resolve(argv[at + 1] ?? ".");
}

/** True when `metaUrl` (the caller's `import.meta.url`) is the script node was started with, not an import. */
export function isEntryPoint(metaUrl: string): boolean {
  return process.argv[1] !== undefined && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

/**
 * Writes a generated docs page, or with `check` only compares it with the file on disk. Returns the exit code: 1 when
 * `check` finds the page out of date, telling the maintainer which npm `script` regenerates it.
 */
export function writeGeneratedPage(o: { root: string; path: string; page: string; script: string; check: boolean }): number {
  const shown = relative(o.root, o.path);
  if (o.check) {
    let current: string | undefined;
    try {
      current = readFileSync(o.path, "utf8");
    } catch {
      current = undefined;
    }
    if (current === o.page) return 0;
    process.stderr.write(`${shown} is out of date: run \`npm run ${o.script}\`\n`);
    return 1;
  }
  mkdirSync(dirname(o.path), { recursive: true });
  writeFileSync(o.path, o.page);
  process.stdout.write(`wrote ${shown}\n`);
  return 0;
}
