// WHAT: Renders every ```mermaid block in the repo's Markdown with @mermaid-js/mermaid-cli and fails on the first kind
//   of error GitHub would show as "Unable to render": a syntax error. Reports each bad block as file:line.
// WHY: A broken diagram passes every other test; only a renderer notices. The CLI drives a headless Chromium, which hangs
//   on the maintainer's machine and is too heavy for a normal `npm ci`, so the gate runs in GitHub Actions only.
// WHEN: In CI (the `mermaid` job of .github/workflows/ci.yml). Locally, only with --list, to see which blocks it would check.
// HOW: `npm run docs:mermaid` renders (CI). `npm run docs:mermaid -- --list` lists `file:line: diagram-type` and renders
//   nothing. `--root <dir>` checks another tree. MERMAID_CLI replaces the renderer command (default: npx --yes
//   @mermaid-js/mermaid-cli@11.17.0); it is called as `<command> -i <in.mmd> -o <out.svg> -p <puppeteer-config.json>`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEntryPoint, rootFromArgs } from "./lib/cli.js";
import { markdownFiles, parseMarkdown, type MermaidBlock } from "./lib/markdown.js";

const DEFAULT_RENDERER = "npx --yes @mermaid-js/mermaid-cli@11.17.0";
const RENDER_TIMEOUT_MS = 120_000;
/** The first run of mermaid-cli downloads itself, puppeteer and Chromium: that is not a render and gets its own, long limit. */
const WARM_UP_TIMEOUT_MS = 600_000;

type Block = MermaidBlock & { file: string };

function findBlocks(root: string): Block[] {
  return markdownFiles(root).flatMap((file) =>
    parseMarkdown(readFileSync(join(root, file), "utf8")).mermaid.map((block) => ({ ...block, file })),
  );
}

/** `flowchart`, `stateDiagram-v2`, ...: the first word of the first line that is not blank or a %% comment/directive. */
function diagramType(source: string): string {
  const first = source.split("\n").find((line) => line.trim() !== "" && !line.trim().startsWith("%%"));
  return first?.trim().split(/\s+/)[0] ?? "(empty)";
}

/** First lines of a failed process's output, on one line. */
function reason(r: { stdout: string; stderr: string; status: number | null }): string {
  return `${r.stderr}${r.stdout}`.trim().split("\n").slice(0, 6).join(" | ") || `exit code ${r.status}`;
}

/** Renders every block; returns one `file:line: message` per block that failed (or one message if the renderer won't start). */
function render(blocks: Block[]): string[] {
  if (blocks.length === 0) return [];
  const [command = "", ...baseArgs] = (process.env.MERMAID_CLI ?? DEFAULT_RENDERER).split(/\s+/).filter(Boolean);
  const work = mkdtempSync(join(tmpdir(), "wf-mermaid-"));
  try {
    // GitHub's runners block the Chromium sandbox for an unprivileged user.
    const puppeteer = join(work, "puppeteer.json");
    writeFileSync(puppeteer, JSON.stringify({ args: ["--no-sandbox"] }));

    const warmUp = spawnSync(command, [...baseArgs, "--version"], { encoding: "utf8", timeout: WARM_UP_TIMEOUT_MS });
    if (warmUp.error || warmUp.status !== 0) {
      return [`could not run the renderer "${command}": ${warmUp.error?.message ?? reason(warmUp)}`];
    }

    const problems: string[] = [];
    blocks.forEach((block, i) => {
      const input = join(work, `${i}.mmd`);
      writeFileSync(input, block.source);
      const r = spawnSync(command, [...baseArgs, "-i", input, "-o", join(work, `${i}.svg`), "-p", puppeteer], {
        encoding: "utf8",
        timeout: RENDER_TIMEOUT_MS,
      });
      if (r.error) problems.push(`${block.file}:${block.line}: could not render, ${r.error.message}`);
      else if (r.status !== 0) problems.push(`${block.file}:${block.line}: Mermaid failed to render: ${reason(r)}`);
    });
    return problems;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const blocks = findBlocks(rootFromArgs(argv));

  if (argv.includes("--list")) {
    for (const block of blocks) console.log(`${block.file}:${block.line}: ${diagramType(block.source)}`);
    return 0;
  }

  const problems = render(blocks);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`mermaid check failed: ${problems.length} problem(s) in ${blocks.length} Mermaid block(s)`);
    return 1;
  }
  console.log(`mermaid check ok: ${blocks.length} Mermaid block(s) rendered`);
  return 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
