// The dashboard's app page (`/`: the Runs, Board and Metrics menus), built when the dashboard starts: `app/main.tsx` (React) and its styles are bundled with esbuild
// into one script and one stylesheet, which the server serves itself. Nothing is fetched from a CDN and users run no build step.
//
// The build is cached on disk by content hash (`<cache>/<hash>/app.js` and `app.css`, in the per-user directory): the hash
// covers every file of `app/` and the versions of React, ReactDOM and esbuild, so a start with the same sources and the same
// packages reads two files instead of building, and any change makes a new hash. A build is written to a temporary folder and
// moved into place whole, so a start that dies halfway, or two that overlap, never leave a half-built entry to be served.
// Only the current hash is kept.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";
import { dashboardCacheDir } from "@cursor-workflows/runtime/observe";

/** The app page's sources, next to `src/`. */
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

/** Change when the build options below change in a way the sources do not show. */
const BUILD_RECIPE = "1";

export interface AppBundle {
  /** 16 hex digits of the content hash: the name of the files the server serves. */
  hash: string;
  js: string;
  css: string;
}

export interface BuildOptions {
  /** The folder holding `main.tsx`. Default: the dashboard's own `app/`. */
  srcDir?: string;
  /** Where builds are kept, by hash. Default: the per-user directory's `dashboard-cache`. */
  cacheDir?: string;
}

function* filesUnder(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

const require = createRequire(import.meta.url);

/** What the build depends on: the sources and the packages bundled into them. */
function contentHash(srcDir: string): string {
  const hash = createHash("sha256").update(`recipe ${BUILD_RECIPE}\0esbuild ${esbuildVersion}\0`);
  for (const pkg of ["react", "react-dom"]) hash.update(`${pkg} ${(require(`${pkg}/package.json`) as { version: string }).version}\0`);
  for (const file of filesUnder(srcDir)) hash.update(`${relative(srcDir, file)}\0`).update(readFileSync(file)).update("\0");
  return hash.digest("hex").slice(0, 16);
}

function readCached(dir: string): Pick<AppBundle, "js" | "css"> | undefined {
  try {
    return { js: readFileSync(join(dir, "app.js"), "utf8"), css: readFileSync(join(dir, "app.css"), "utf8") };
  } catch {
    return undefined;
  }
}

async function bundle(srcDir: string): Promise<Pick<AppBundle, "js" | "css">> {
  const result = await build({
    entryPoints: [join(srcDir, "main.tsx")],
    entryNames: "app",
    outdir: "out",
    write: false,
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    jsx: "automatic",
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    // React comes from this package's install, wherever the sources are (a copy of `app/` elsewhere builds the same way).
    nodePaths: [dirname(dirname(require.resolve("react/package.json")))],
    logLevel: "silent",
  });
  const text = (extension: string) => result.outputFiles.find((file) => file.path.endsWith(extension))?.text ?? "";
  return { js: text(".js"), css: text(".css") };
}

/** Only the current build is kept. Temporary folders of other starts (their names begin with a dot) are theirs to remove. */
function pruneOthers(cacheDir: string, keep: string): void {
  for (const name of readdirSync(cacheDir)) if (name !== keep && !name.startsWith(".")) rmSync(join(cacheDir, name), { recursive: true, force: true });
}

/** The web app, from the cache when the sources and packages are the ones already built, else built now. Throws with esbuild's message when the sources do not build. */
export async function buildApp(options: BuildOptions = {}): Promise<AppBundle> {
  const srcDir = options.srcDir ?? UI_DIR;
  const cacheDir = options.cacheDir ?? dashboardCacheDir();
  const hash = contentHash(srcDir);
  const home = join(cacheDir, hash);

  let built = readCached(home);
  if (!built) {
    built = await bundle(srcDir);
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const staging = join(cacheDir, `.${hash}-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(staging);
    try {
      writeFileSync(join(staging, "app.js"), built.js);
      writeFileSync(join(staging, "app.css"), built.css);
      rmSync(home, { recursive: true, force: true }); // an incomplete entry from an older start
      try {
        renameSync(staging, home);
      } catch (err) {
        // Another start moved its build into place first: the content is the same.
        if (!existsSync(join(home, "app.js"))) throw err;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  pruneOthers(cacheDir, hash);
  return { hash, ...built };
}
