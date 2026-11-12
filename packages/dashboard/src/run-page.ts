// The HTML of the Run view page: a root element, the app's style and its script. All logic is in the script.
import type { UiBundle } from "./ui-bundle.js";

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Sent with the page: scripts and connections from this origin only. React Flow styles its nodes with `style` attributes, hence `style-src-attr`; no inline element style or script is allowed. */
export const RUN_PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function runPage(runId: string, ui: UiBundle): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Run ${escapeHtml(runId)} · cursor-workflows</title>
<link rel="stylesheet" href="/assets/${ui.style.name}">
</head>
<body>
<div id="root"></div>
<script type="module" src="/assets/${ui.script.name}"></script>
</body>
</html>
`;
}
