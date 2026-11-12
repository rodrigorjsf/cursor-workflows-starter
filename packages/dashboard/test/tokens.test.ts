// Seam: the stylesheets, read as text. Both pages draw from one palette, `app/tokens.css`: the status colours, the surfaces, the
// text colours, the spacing and type scales. These tests compute the WCAG 2 contrast of every text colour on every surface, in
// the light scheme and in the dark one, from the token file itself, so a new token or a new value is checked as it lands.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { PACKAGE, pageSources } from "./render.js";

const TOKENS = join(PACKAGE, "app", "tokens.css");

/** The statuses a pill, a badge, a node or a column shows. Each has a text colour `--s-<name>` and a tint `--s-<name>-bg` to sit on. */
const STATUSES = ["running", "ok", "failed", "cancelled", "waiting", "neutral", "merged", "cached", "interrupted"];
/** What text is drawn on: the page, a card or panel, and the muted surface of a column or a table's head. */
const SURFACES = ["--bg", "--surface", "--surface-muted"];
/** Text colours that must read on every surface. */
const TEXT = ["--fg", "--fg-muted", "--accent", ...STATUSES.map((s) => `--s-${s}`)];
/** Chart series: graphics, which WCAG 1.4.11 holds to 3:1. */
const SERIES = [1, 2, 3, 4, 5, 6].map((n) => `--chart-${n}`);

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The custom properties declared directly in `block`. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** The body of the first `{ … }` that follows `from` in `css`, braces balanced. */
function bodyAfter(css: string, from: number): string {
  const open = css.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

/** The tokens of the light scheme (`:root`) and of the dark one (the light ones, with what the dark `:root` redefines). */
function schemes(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const text = withoutComments(css);
  const media = text.indexOf("@media (prefers-color-scheme: dark)");
  assert.ok(media >= 0, "tokens.css redefines the palette under prefers-color-scheme: dark");
  const light = declarations(bodyAfter(text, text.indexOf(":root")));
  const darkBlock = bodyAfter(text, media);
  const dark = new Map([...light, ...declarations(bodyAfter(darkBlock, darkBlock.indexOf(":root")))]);
  return { light, dark };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;

test("one palette: colours are written only in app/tokens.css, and both pages load it", () => {
  assert.ok(existsSync(TOKENS), "app/tokens.css holds the palette");
  for (const [path, text] of pageSources(".css", ".ts", ".tsx")) {
    if (path === TOKENS) continue;
    const source = path.endsWith(".css") ? withoutComments(text) : text.replace(/^\s*\/\/.*$/gm, "");
    const hit = COLOR_LITERAL.exec(source);
    assert.equal(hit, null, `${relative(PACKAGE, path)} writes a colour of its own (${hit?.[0]}): use a token from app/tokens.css`);
  }
  for (const entry of ["app/main.tsx", "run-view/run-page.tsx"]) {
    assert.match(readFileSync(join(PACKAGE, entry), "utf8"), /import\s+["'][./]*(?:app\/)?tokens\.css["']/, `${entry} loads the tokens`);
  }
});

test("every text colour, status colour and link meets WCAG AA (4.5:1) on every surface and on its own tint, in light and in dark", () => {
  assert.ok(existsSync(TOKENS), "app/tokens.css holds the palette");
  const { light, dark } = schemes(readFileSync(TOKENS, "utf8"));
  for (const [scheme, tokens] of [["light", light], ["dark", dark]] as const) {
    const value = (name: string): string => {
      const v = tokens.get(name);
      assert.ok(v !== undefined, `${scheme}: ${name} is defined`);
      assert.match(v, /^#[0-9a-fA-F]{6}$/, `${scheme}: ${name} is a plain hex colour (${v}), so its contrast can be checked`);
      return v;
    };
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        const ratio = contrast(value(text), value(surface));
        assert.ok(ratio >= 4.5, `${scheme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1, under 4.5:1`);
      }
    }
    for (const status of STATUSES) {
      const ratio = contrast(value(`--s-${status}`), value(`--s-${status}-bg`));
      assert.ok(ratio >= 4.5, `${scheme}: --s-${status} on its tint is ${ratio.toFixed(2)}:1, under 4.5:1`);
    }
    for (const series of SERIES) {
      const ratio = contrast(value(series), value("--surface"));
      assert.ok(ratio >= 3, `${scheme}: ${series} on --surface is ${ratio.toFixed(2)}:1, under 3:1`);
    }
  }
});
