#!/usr/bin/env python3
"""Playwright driver for the verification dashboard.

Keeps one headless Chromium for the instance in .cursor/skills/verify-dashboard/state/current.json.
The first command starts it. `close` stops it. It refuses port 4317.

Invocation (from the repo root):

    uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py goto --path /#/runs
    uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py click --role link --name ship-feature-9a516b50
    uvx --with playwright==1.65.1 python -I .cursor/skills/verify-dashboard/drive.py close
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("VERIFY_DASH_STATE_DIR", Path(__file__).resolve().parent / "state"))
STATE = STATE_DIR / "current.json"
SOCK = Path("/tmp") / f"verify-dashboard-{hashlib.sha256(str(STATE_DIR.resolve()).encode()).hexdigest()[:16]}.sock"
META = STATE_DIR / "browser.json"


def instance() -> dict:
    if not STATE.is_file():
        raise SystemExit(f"drive.py: no instance record at {STATE} (run verify-dashboard.sh up first)")
    data = json.loads(STATE.read_text())
    if int(data["port"]) == 4317:
        raise SystemExit("drive.py: refusing port 4317")
    return data


def call(request: dict) -> dict:
    ensure()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(60)
            sock.connect(str(SOCK))
            sock.sendall(json.dumps(request).encode() + b"\n")
            buf = b""
            while b"\n" not in buf:
                chunk = sock.recv(1 << 20)
                if not chunk:
                    break
                buf += chunk
    except (ConnectionResetError, BrokenPipeError, socket.timeout) as exc:
        detail = (STATE_DIR / "browser.log").read_text(errors="replace") if (STATE_DIR / "browser.log").is_file() else str(exc)
        raise SystemExit(f"drive.py: browser closed: {detail.splitlines()[-1]}") from exc
    if not buf:
        raise SystemExit("drive.py: browser closed before it replied")
    reply = json.loads(buf.decode())
    if not reply.get("ok"):
        raise SystemExit(f"drive.py: {reply.get('error', reply)}")
    if reply.get("out") is not None:
        print(reply["out"])
    return reply


def ensure() -> None:
    if META.is_file():
        pid = json.loads(META.read_text()).get("pid")
        if pid and Path(f"/proc/{pid}").exists() and SOCK.exists():
            return
    record = instance()
    SOCK.unlink(missing_ok=True)
    META.unlink(missing_ok=True)
    log_handle = open(STATE_DIR / "browser-serve.log", "ab")
    subprocess.Popen(
        [sys.executable, __file__, "--serve"],
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=log_handle,
        env={**os.environ, "VERIFY_DASH_URL": record["url"]},
    )
    log_handle.close()
    for _ in range(120):
        if META.is_file() and SOCK.exists():
            return
        time.sleep(0.25)
    raise SystemExit("drive.py: browser did not start in 30s")


def serve() -> None:
    from playwright.sync_api import sync_playwright

    base = os.environ["VERIFY_DASH_URL"].rstrip("/")
    if base.endswith(":4317") or ":4317/" in base:
        raise SystemExit("drive.py: refusing port 4317")
    log = STATE_DIR / "browser.log"
    SOCK.unlink(missing_ok=True)
    META.unlink(missing_ok=True)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(SOCK))
            server.listen(8)
            META.write_text(json.dumps({"pid": os.getpid(), "url": base, "sock": str(SOCK)}) + "\n")
            try:
                while True:
                    conn, _ = server.accept()
                    with conn:
                        buf = b""
                        while b"\n" not in buf:
                            chunk = conn.recv(1 << 20)
                            if not chunk:
                                break
                            buf += chunk
                        if not buf:
                            continue
                        request = json.loads(buf.decode())
                        try:
                            reply = handle(page, base, request)
                        except Exception as exc:  # noqa: BLE001 — one line back to the client
                            reply = {"ok": False, "error": str(exc).split("\n", 1)[0]}
                        conn.sendall(json.dumps(reply).encode() + b"\n")
                        if request.get("op") == "close":
                            break
            finally:
                browser.close()
                SOCK.unlink(missing_ok=True)
                META.unlink(missing_ok=True)
    except Exception as exc:
        log.write_text(str(exc))
        SOCK.unlink(missing_ok=True)
        META.unlink(missing_ok=True)
        raise


def handle(page, base: str, request: dict) -> dict:
    op = request["op"]
    if op == "goto":
        path = request["path"]
        if not path.startswith("/"):
            raise ValueError(f"path must start with /, got {path!r}")
        page.goto(base + path, wait_until="domcontentloaded")
        return {"ok": True, "out": page.url}
    if op == "wait":
        page.get_by_text(request["text"], exact=request.get("exact", False)).first.wait_for(state="visible", timeout=request.get("timeout", 15000))
        return {"ok": True, "out": request["text"]}
    if op == "click":
        name = request.get("name")
        exact = request.get("exact", True)
        if request.get("name_regex"):
            import re
            name = re.compile(request["name_regex"])
            exact = False
        page.get_by_role(request["role"], name=name, exact=exact).click(timeout=15000)
        return {"ok": True, "out": f"clicked {request['role']} {request.get('name_regex', request.get('name'))}"}
    if op == "fill":
        page.get_by_role(request["role"], name=request["name"], exact=True).fill(request["value"])
        return {"ok": True, "out": request["value"]}
    if op == "select":
        page.get_by_role("combobox", name=request["name"], exact=True).select_option(request["value"])
        return {"ok": True, "out": request["value"]}
    if op == "snapshot":
        target = Path(request["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page.locator("body").aria_snapshot() + "\n")
        return {"ok": True, "out": str(target)}
    if op == "screenshot":
        target = Path(request["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(target), full_page=bool(request.get("full_page", False)))
        return {"ok": True, "out": str(target)}
    if op == "title":
        return {"ok": True, "out": page.title()}
    if op == "url":
        return {"ok": True, "out": page.url}
    if op == "count":
        count = page.get_by_text(request["text"], exact=request.get("exact", True)).count()
        return {"ok": True, "out": str(count)}
    if op == "contains":
        body = page.locator("body").inner_text()
        if request["text"] not in body:
            raise ValueError(f"page text has no {request['text']!r}")
        return {"ok": True, "out": request["text"]}
    if op == "close":
        return {"ok": True, "out": "closed"}
    raise ValueError(f"unknown op {op}")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        serve()
        return
    parser = argparse.ArgumentParser(description="Drive the verification dashboard with Playwright")
    sub = parser.add_subparsers(dest="op", required=True)
    goto = sub.add_parser("goto")
    goto.add_argument("--path", required=True)
    wait = sub.add_parser("wait")
    wait.add_argument("--text", required=True)
    click = sub.add_parser("click")
    click.add_argument("--role", required=True)
    click.add_argument("--name")
    click.add_argument("--name-regex")
    fill = sub.add_parser("fill")
    fill.add_argument("--role", required=True)
    fill.add_argument("--name", required=True)
    fill.add_argument("--value", required=True)
    select = sub.add_parser("select")
    select.add_argument("--name", required=True)
    select.add_argument("--value", required=True)
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--path", required=True)
    screenshot = sub.add_parser("screenshot")
    screenshot.add_argument("--path", required=True)
    screenshot.add_argument("--full-page", action="store_true")
    sub.add_parser("title")
    sub.add_parser("url")
    count = sub.add_parser("count")
    count.add_argument("--text", required=True)
    contains = sub.add_parser("contains")
    contains.add_argument("--text", required=True)
    sub.add_parser("close")
    args = parser.parse_args()
    request = {key: value for key, value in vars(args).items() if key != "op" and value is not None}
    request["op"] = args.op
    if getattr(args, "full_page", False):
        request["full_page"] = True
    if request["op"] == "click" and not request.get("name") and not request.get("name_regex"):
        raise SystemExit("drive.py: click needs --name or --name-regex")
    call(request)


if __name__ == "__main__":
    main()
