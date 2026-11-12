// WHAT: Shared command-line plumbing for the maintainer scripts: which repo root to check (`--root <dir>`, default: the
//   repo this script lives in) and whether the file is being run as the entry point.
// WHY: scripts/check-docs.ts and scripts/check-mermaid.ts took their root and ran `main` the same way; one copy keeps them alike.
// WHEN: imported by those scripts; not run on its own.
// HOW: `const root = rootFromArgs(process.argv.slice(2))`; `if (isEntryPoint(import.meta.url)) process.exitCode = main(...)`.
import { resolve } from "node:path";
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
