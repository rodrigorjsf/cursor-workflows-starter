// The source fingerprint of a workflow file: its own text plus every module it imports by relative path, transitively.
// `run.toString()` alone misses edits to prompts, helpers and other modules the workflow imports, so a resume that
// mixes versions would go unnoticed. The runtime's own `src/` is left out: a kit upgrade is not a workflow change.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { WorkflowDefinition } from "./workflow.js";

const RUNTIME_SRC = resolve(import.meta.dirname, "..") + sep;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

const fingerprints = new WeakMap<WorkflowDefinition<any, any>, string>();

/** Records the source fingerprint of the file `def` was loaded from. */
export function recordWorkflowSource(def: WorkflowDefinition<any, any>, file: string): void {
  fingerprints.set(def, hashWorkflowSource(file));
}

/** The source fingerprint recorded for `def`, or undefined when it was not loaded from a file (a test, an inline def). */
export function workflowSourceHash(def: WorkflowDefinition<any, any>): string | undefined {
  return fingerprints.get(def);
}

/** Hashes `entry` and every file it reaches through relative imports, outside the runtime's own `src/`. */
export function hashWorkflowSource(entry: string): string {
  const hash = createHash("sha256");
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    hash.update(text).update("\0"); // the text, not the path: a relocated kit is the same code
    for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
      const target = resolveImport(dirname(file), specifier!);
      if (target && !target.startsWith(RUNTIME_SRC)) visit(target);
    }
  };
  visit(resolve(entry));
  return hash.digest("hex");
}

/** A relative specifier as the TypeScript loader resolves it: `./x.js` may name `./x.ts`. */
function resolveImport(fromDir: string, specifier: string): string | undefined {
  const base = resolve(fromDir, specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, `${base}.js`];
  return candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile());
}
