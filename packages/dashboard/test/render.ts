// Renders a component of the pages to HTML in Node, with no DOM: what the browser would first paint for the given props.
// Effects do not run, so a component is rendered with its data handed to it, not fetched. The tests compile JSX with the
// classic runtime (`React.createElement`), hence the global.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

(globalThis as { React?: unknown }).React = React;

export function render<P extends object>(component: (props: P) => React.ReactNode, props: P): string {
  return renderToStaticMarkup(React.createElement(component as React.FC<P>, props));
}

/** The text a reader sees in rendered HTML: tags dropped, entities decoded, whitespace collapsed. */
export const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** The dashboard package's folder. */
export const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under the pages' sources (`app/`, `run-view/`) whose name ends with one of `extensions`, as [path, text]. */
export function pageSources(...extensions: string[]): Array<[path: string, text: string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push([path, readFileSync(path, "utf8")]);
    }
  };
  for (const tree of ["app", "run-view"]) walk(join(PACKAGE, tree));
  return out;
}
