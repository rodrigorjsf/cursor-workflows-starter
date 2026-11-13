# WHAT: Screenshots a running dashboard: the Runs, Board and Metrics pages and the Run view of every run it lists, at
# 360 and 1440 px wide, in the light and the dark scheme, into a folder. Prints probes per page: horizontal overflow
# (and the elements past the right edge) and console errors, warnings and page errors.
# WHY: Every dashboard review needs the same captures and the same checks. A harness rebuilt per session costs a
# critic hundreds of thousands of tokens and checks something different each time.
# WHEN: After changing the dashboard (app/, run-view/, the CSS), against fixture runs from scripts/dev/dash-fixtures.ts.
# HOW: once per machine, `uvx --with playwright==1.65.1 playwright install chromium`; then, with the dashboard up
# (`WF_HOME=<fixture home> WF_DASH_PORT=4399 npm run dash`),
# `uvx --with playwright==1.65.1 python -I scripts/dev/dash-shots.py http://127.0.0.1:4399 <out-dir>`.
# `--strict` exits 1 when a probe finds something; `--browser <path>` uses a Chrome or Chromium already on the machine
# instead of the installed one. No npm dependency: Playwright comes from uvx.
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

WIDTHS = [(360, 780), (1440, 900)]
SCHEMES = ["light", "dark"]
# Elements past the right edge of the page. The canvas, the board's columns and the tables scroll inside themselves.
OVERFLOW = """() => {
  const cw = document.documentElement.clientWidth;
  const past = [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > cw + 1 && !e.closest('.react-flow, .columns, .table-wrap');
  });
  return { scrollWidth: document.documentElement.scrollWidth, clientWidth: cw,
           past: past.slice(0, 8).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).trim().replace(/\\s+/g, '.')}:${Math.round(e.getBoundingClientRect().right)}`) };
}"""


def runs_of(base: str) -> list[dict]:
    with urllib.request.urlopen(f"{base}/api/runs") as reply:
        return json.load(reply)["runs"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Screenshot a running dashboard and probe each page.")
    parser.add_argument("url", help="the dashboard, e.g. http://127.0.0.1:4399")
    parser.add_argument("out", help="the folder the PNGs and probes.json go to")
    parser.add_argument("--wait-ms", type=int, default=1500, help="how long each page settles before the capture")
    parser.add_argument("--strict", action="store_true", help="exit 1 when a probe finds overflow or a console message")
    parser.add_argument("--browser", help="a Chrome or Chromium executable to use instead of Playwright's own")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    pages = [("runs", "/#/runs"), ("board", "/#/board"), ("metrics", "/#/metrics")]
    for run in runs_of(base):
        name = re.sub(r"[^a-z0-9-]+", "-", f"run-{run['status']}-{run['runId']}".lower())
        pages.append((name, f"/runs/{run['runId']}"))

    probes: dict[str, dict] = {}
    problems = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser)
        for scheme in SCHEMES:
            for width, height in WIDTHS:
                context = browser.new_context(viewport={"width": width, "height": height}, color_scheme=scheme)
                page = context.new_page()
                messages: list[str] = []
                page.on("console", lambda m: messages.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
                page.on("pageerror", lambda e: messages.append(f"pageerror: {e}"))
                for name, path in pages:
                    messages.clear()
                    page.goto(base + path)
                    page.wait_for_timeout(args.wait_ms)
                    key = f"{name}-{width}-{scheme}"
                    overflow = page.evaluate(OVERFLOW)
                    # The Run view is a full-height canvas; the other pages are captured whole.
                    page.screenshot(path=str(out / f"{key}.png"), full_page=not name.startswith("run-"))
                    found = overflow["scrollWidth"] > overflow["clientWidth"] or bool(overflow["past"]) or bool(messages)
                    problems += found
                    probes[key] = {"overflow": overflow, "console": list(messages)}
                    detail = []
                    if overflow["scrollWidth"] > overflow["clientWidth"] or overflow["past"]:
                        detail.append(f"overflow {overflow['scrollWidth']}>{overflow['clientWidth']} {' '.join(overflow['past'])}")
                    detail += messages
                    print(f"{'!!' if found else 'ok'} {key}" + "".join(f"\n   {d}" for d in detail))
                context.close()
        browser.close()

    (out / "probes.json").write_text(json.dumps(probes, indent=1) + "\n")
    print(f"{len(probes)} captures in {out}; {problems} with findings (probes.json has them all)")
    return 1 if args.strict and problems else 0


if __name__ == "__main__":
    sys.exit(main())
