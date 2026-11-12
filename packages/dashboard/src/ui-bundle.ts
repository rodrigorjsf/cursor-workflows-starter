// The Run view page (`/runs/<runId>`), built by the dashboard itself: esbuild bundles `run-view/run-page.tsx` (React, React Flow and elkjs
// included) the first time a page asks for it, and the files are served from memory, named by the hash of their content.
// There is no build step for the user and nothing is fetched from another site, so the page works offline under a strict
// content security policy.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { build, stop } from "esbuild";

export interface UiAsset {
  /** The file name under `/assets/`: `<entry>-<hash of the content>.<ext>`. */
  name: string;
  type: string;
  body: string;
}

/** What a build produced: the files by name, and which of them is the script and the style a page loads. */
export interface UiBundle {
  assets: ReadonlyMap<string, UiAsset>;
  script: UiAsset;
  style: UiAsset;
}

const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

async function buildBundle(): Promise<UiBundle> {
  try {
    const built = await build({
      entryPoints: { run: join(import.meta.dirname, "..", "run-view", "run-page.tsx") },
      bundle: true,
      write: false,
      outdir: "out",
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      minify: true,
      legalComments: "none",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const assets = new Map<string, UiAsset>();
    for (const file of built.outputFiles) {
      const ext = file.path.slice(file.path.lastIndexOf("."));
      const type = TYPES[ext];
      if (!type) continue;
      const hash = createHash("sha256").update(file.text).digest("hex").slice(0, 12);
      const name = `run-${hash}${ext}`;
      assets.set(name, { name, type, body: file.text });
    }
    const named = (ext: string) => [...assets.values()].find((a) => a.name.endsWith(ext));
    const script = named(".js");
    const style = named(".css");
    if (!script || !style) throw new Error("the UI build produced no script or no style");
    return { assets, script, style };
  } finally {
    await stop(); // the build is done: do not keep esbuild's helper process for the life of the dashboard
  }
}

let bundle: Promise<UiBundle> | undefined;

/** The built app. Built on first use and kept: concurrent callers share one build, and a failed build is tried again by the next call. */
export function uiBundle(): Promise<UiBundle> {
  if (!bundle) {
    bundle = buildBundle();
    bundle.catch(() => {
      bundle = undefined;
    });
  }
  return bundle;
}
