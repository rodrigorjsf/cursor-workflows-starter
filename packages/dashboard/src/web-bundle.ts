// The dashboard's two pages, built when the dashboard starts: esbuild bundles the app page (`app/main.tsx`: the Runs, Board
// and Metrics menus, served at `/`) and the Run view page (`run-view/run-page.tsx`: one run's live graph, served at
// `/runs/<runId>`), each into one script and one stylesheet, which the server serves itself. Nothing is fetched from a CDN
// and users run no build step.
//
// The build is cached on disk by content hash (`<cache>/<hash>/app.js`, `app.css`, `run.js` and `run.css`, in the per-user
// directory): the hash covers every file of `app/` and `run-view/` and the versions of the packages bundled into them and of
// esbuild, so a start with the same sources and the same packages reads four files instead of building, and any change makes
// a new hash. A build is written to a temporary folder and moved into place whole, so a start that dies halfway, or two that
// overlap, never leave a half-built entry to be served. Only the current hash is kept.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop, version as esbuildVersion } from "esbuild";
import { dashboardCacheDir } from "@cursor-workflows/runtime/observe";

/** The dashboard package's folder, which holds `app/` and `run-view/`. */
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Change when the build options below change in a way the sources do not show. */
const BUILD_RECIPE = "3";

/** The pages, by the name their files take: the entry each is built from, under the package folder. */
const PAGES = { app: join("app", "main.tsx"), run: join("run-view", "run-page.tsx") } as const;
export type PageName = keyof typeof PAGES;

/** The packages bundled into the pages: a new version of any of them is a new build. */
const BUNDLED = ["react", "react-dom", "@xyflow/react", "elkjs"];

/** The built files, by name: `app.js`, `app.css`, `run.js`, `run.css`. */
export const FILES = Object.keys(PAGES).flatMap((page) => [`${page}.js`, `${page}.css`]);

export interface WebBundle {
  /** 16 hex digits of the content hash: part of the name of every file the server serves. */
  hash: string;
  /** The content of each of `FILES`. */
  files: Record<string, string>;
}

export interface BuildOptions {
  /** The folder holding `app/` and `run-view/`. Default: the dashboard package's own. */
  root?: string;
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
const packageJson = (pkg: string): string => require.resolve(`${pkg}/package.json`);

/** What the build depends on: the sources of both pages and the packages bundled into them. */
function contentHash(root: string): string {
  const hash = createHash("sha256").update(`recipe ${BUILD_RECIPE}\0esbuild ${esbuildVersion}\0`);
  for (const pkg of BUNDLED) hash.update(`${pkg} ${(JSON.parse(readFileSync(packageJson(pkg), "utf8")) as { version: string }).version}\0`);
  for (const tree of new Set(Object.values(PAGES).map(dirname))) {
    for (const file of filesUnder(join(root, tree))) hash.update(`${relative(root, file)}\0`).update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function readCached(dir: string): Record<string, string> | undefined {
  try {
    return Object.fromEntries(FILES.map((name) => [name, readFileSync(join(dir, name), "utf8")]));
  } catch {
    return undefined;
  }
}

/** Builds in flight: esbuild's helper process is stopped once the last one ends, so the dashboard does not keep it for its whole life. */
let building = 0;

async function bundle(root: string): Promise<Record<string, string>> {
  building++;
  try {
    const result = await build({
      entryPoints: Object.fromEntries(Object.entries(PAGES).map(([name, entry]) => [name, join(root, entry)])),
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
      // The packages come from this package's install, wherever the sources are (a copy elsewhere builds the same way).
      nodePaths: [...new Set(BUNDLED.map((pkg) => dirname(packageJson(pkg)).slice(0, -(pkg.length + 1))))],
      logLevel: "silent",
    });
    const files = Object.fromEntries(result.outputFiles.map((file) => [basename(file.path), file.text]));
    for (const name of FILES) if (files[name] === undefined) throw new Error(`the build produced no ${name}`);
    return Object.fromEntries(FILES.map((name) => [name, files[name]!]));
  } finally {
    if (--building === 0) await stop();
  }
}

/** Only the current build is kept. Temporary folders of other starts (their names begin with a dot) are theirs to remove. */
function pruneOthers(cacheDir: string, keep: string): void {
  for (const name of readdirSync(cacheDir)) if (name !== keep && !name.startsWith(".")) rmSync(join(cacheDir, name), { recursive: true, force: true });
}

/** Both pages, from the cache when the sources and packages are the ones already built, else built now. Throws with esbuild's message when the sources do not build. */
export async function buildWeb(options: BuildOptions = {}): Promise<WebBundle> {
  const root = options.root ?? PACKAGE_DIR;
  const cacheDir = options.cacheDir ?? dashboardCacheDir();
  const hash = contentHash(root);
  const home = join(cacheDir, hash);

  let files = readCached(home);
  if (!files) {
    files = await bundle(root);
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const staging = join(cacheDir, `.${hash}-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(staging);
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(staging, name), text);
      rmSync(home, { recursive: true, force: true }); // an incomplete entry from an older start
      try {
        renameSync(staging, home);
      } catch (err) {
        // Another start moved its build into place first: the content is the same.
        if (!FILES.every((name) => existsSync(join(home, name)))) throw err;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  pruneOthers(cacheDir, hash);
  return { hash, files };
}
