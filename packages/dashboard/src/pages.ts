// The HTML of the dashboard's two pages (see web-bundle.ts): a root element, the page's style and its script, all named
// after the build's hash. All logic is in the script; nothing is inline and nothing comes from another origin.
import type { PageName } from "./web-bundle.js";

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const BASE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

/** Sent with each page: scripts, styles and connections from this origin only. React Flow styles the Run view's nodes with `style` attributes, hence its `style-src-attr`; no inline element style or script is allowed on either page. */
export const PAGE_POLICY: Record<PageName, string> = {
  app: BASE_POLICY.join("; "),
  run: [...BASE_POLICY, "style-src-attr 'unsafe-inline'"].join("; "),
};

/** The path the server serves a built file at: `/assets/<page>.<hash>.<js|css>`. */
export const assetPath = (file: string, hash: string): string => `/assets/${file.replace(/\.(js|css)$/, `.${hash}.$1`)}`;

export function pageHtml(page: PageName, hash: string, title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${assetPath(`${page}.css`, hash)}">
</head>
<body>
<div id="root"></div>
<script type="module" src="${assetPath(`${page}.js`, hash)}"></script>
</body>
</html>
`;
}
