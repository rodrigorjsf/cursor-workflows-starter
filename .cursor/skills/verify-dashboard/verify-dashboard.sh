#!/usr/bin/env bash
# WHAT: Starts, checks, and stops one disposable Cursor Workflows dashboard for verification.
# WHY: The dashboard on port 4317 is the user's. A proof has to use its own WF_HOME and port.
# WHEN: Before driving the dashboard, whenever doctor looks wrong, and after the proof (including a failed attempt).
# HOW: verify-dashboard.sh up | doctor | down
# `up` builds fixture runs with scripts/dev/dash-fixtures.ts, listens on 127.0.0.1, and writes state/current.json next to this script.
# `doctor` is read-only. `down` kills the pid this script started and deletes that WF_HOME. It does not delete evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STATE_DIR="${VERIFY_DASH_STATE_DIR:-$(cd "$(dirname "$0")" && pwd)/state}"
STATE="$STATE_DIR/current.json"
EVIDENCE_ROOT="$ROOT/.cursor/skills/verify-dashboard/evidence"
TSX="$ROOT/node_modules/.bin/tsx"

die() { printf 'verify-dashboard: %s\n' "$1" >&2; exit 1; }

port_busy() {
  python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(0.2); r=s.connect_ex(("127.0.0.1", int(sys.argv[1]))); s.close(); sys.exit(0 if r==0 else 1)' "$1"
}

pick_port() {
  local port=4400
  while port_busy "$port"; do
    port=$((port + 1))
    if [[ "$port" -eq 4317 ]]; then port=4318; fi
    if [[ "$port" -gt 4500 ]]; then die "no free port between 4400 and 4500"; fi
  done
  if [[ "$port" -eq 4317 ]]; then die "refusing port 4317"; fi
  printf '%s\n' "$port"
}

write_state() {
  python3 -c 'import json,sys; json.dump(json.loads(sys.argv[1]), open(sys.argv[2], "w"), indent=2); open(sys.argv[2], "a").write("\n")' "$1" "$STATE"
}

read_state() {
  [[ -f "$STATE" ]] || die "no instance record at $STATE (run up first)"
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$STATE" "$1"
}

cmd_up() {
  [[ -x "$TSX" ]] || die "missing $TSX (run mise exec -- npm ci --prefer-offline from the repo root)"
  mkdir -p "$STATE_DIR"
  if [[ -f "$STATE" ]]; then
    die "instance record already at $STATE; run down before up"
  fi
  local id home evidence port log
  id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  home="$(mktemp -d /tmp/verify-dashboard-home-XXXXXX)"
  evidence="$EVIDENCE_ROOT/$id"
  mkdir -p "$evidence"
  port="$(pick_port)"
  log="$STATE_DIR/$id.log"
  printf 'verify-dashboard: building fixture runs in %s\n' "$home" >&2
  if ! mise exec -- "$TSX" "$ROOT/scripts/dev/dash-fixtures.ts" --home "$home" >"$evidence/fixtures-stdout.json"; then
    rm -rf "$home"
    die "dash-fixtures failed; the home was removed"
  fi
  printf 'verify-dashboard: starting dashboard on 127.0.0.1:%s\n' "$port" >&2
  WF_HOME="$home" \
    WF_METRICS_DB="$home/metrics.db" \
    WF_DASH_PORT="$port" \
    WF_DASH_AUTOSTART=off \
    mise exec -- "$TSX" "$ROOT/packages/dashboard/src/main.ts" >"$log" 2>&1 &
  local shell_pid=$!
  write_state "$(python3 -c 'import json,sys; print(json.dumps({"id":sys.argv[1],"url":"http://127.0.0.1:"+sys.argv[2],"port":int(sys.argv[2]),"pid":None,"shellPid":int(sys.argv[3]),"home":sys.argv[4],"evidence":sys.argv[5],"log":sys.argv[6],"fixtures":sys.argv[4]+"/fixtures.json","isolatedContext":"verify-dashboard-"+sys.argv[1]}))' "$id" "$port" "$shell_pid" "$home" "$evidence" "$log")"
  local health="$evidence/health-up.json" ready=0 i
  for i in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" -o "$health" 2>/dev/null; then
      ready=1
      break
    fi
    if ! kill -0 "$shell_pid" 2>/dev/null; then
      printf 'verify-dashboard: process exited; log follows\n' >&2
      tail -n 40 "$log" >&2 || true
      die "dashboard exited before it listened"
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    kill "$shell_pid" 2>/dev/null || true
    die "dashboard did not answer /api/health within 90s; log is $log"
  fi
  local pid
  pid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$health")"
  write_state "$(python3 -c 'import json,sys; print(json.dumps({"id":sys.argv[1],"url":"http://127.0.0.1:"+sys.argv[2],"port":int(sys.argv[2]),"pid":int(sys.argv[3]),"shellPid":int(sys.argv[4]),"home":sys.argv[5],"evidence":sys.argv[6],"log":sys.argv[7],"fixtures":sys.argv[5]+"/fixtures.json","isolatedContext":"verify-dashboard-"+sys.argv[1]}))' "$id" "$port" "$pid" "$shell_pid" "$home" "$evidence" "$log")"
  printf 'verify-dashboard: ready %s evidence %s\n' "http://127.0.0.1:${port}" "$evidence" >&2
  cat "$STATE"
}

cmd_doctor() {
  local url port pid home evidence log fixtures
  url="$(read_state url)"
  port="$(read_state port)"
  pid="$(read_state pid)"
  home="$(read_state home)"
  evidence="$(read_state evidence)"
  log="$(read_state log)"
  fixtures="$(read_state fixtures)"
  [[ "$port" != "4317" ]] || die "port is 4317, the user dashboard; refusing"
  [[ "$pid" != "None" && -n "$pid" ]] || die "pid is empty; up did not finish"
  kill -0 "$pid" 2>/dev/null || die "pid $pid is not running"
  local kit_home real_home
  kit_home="$(python3 -c 'import os; print(os.path.realpath(os.path.expanduser("~/.cursor-workflows")))')"
  real_home="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$home")"
  [[ "$real_home" != "$kit_home" && "$real_home" != "$kit_home"/* ]] || die "WF_HOME is the user kit home"
  mkdir -p "$evidence"
  curl -fsS "$url/api/health" -o "$evidence/doctor-health.json"
  python3 - "$evidence/doctor-health.json" "$pid" "$port" "$home" "$log" "$fixtures" <<'PY'
import json, pathlib, sys
health_path, pid, port, home, log, fixtures = sys.argv[1:]
body = json.loads(pathlib.Path(health_path).read_text())
problems = []
if body.get("app") != "cursor-workflows-dashboard":
    problems.append(f"health app is {body.get('app')!r}")
if str(body.get("pid")) != str(pid):
    problems.append(f"health pid {body.get('pid')} != record {pid}")
text = pathlib.Path(log).read_text(errors="replace")
listen = f"dashboard listening on http://127.0.0.1:{port} (metrics database: {home}/metrics.db)"
if listen not in text:
    problems.append("log is missing the listening line for this port and metrics database")
if "web app built (" not in text:
    problems.append("log is missing the web bundle line")
env = pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
env_map = dict(item.split(b"=", 1) for item in env if b"=" in item)
for key, expect in ((b"WF_HOME", home.encode()), (b"WF_DASH_PORT", str(port).encode()), (b"WF_METRICS_DB", f"{home}/metrics.db".encode()), (b"WF_DASH_AUTOSTART", b"off")):
    if env_map.get(key) != expect:
        problems.append(f"{key.decode()} is {env_map.get(key)!r}, expected {expect.decode()!r}")
pid_file = pathlib.Path(home) / "dashboard.pid"
recorded = json.loads(pid_file.read_text())
if recorded.get("pid") != int(pid) or recorded.get("port") != int(port):
    problems.append(f"dashboard.pid is {recorded}, expected pid {pid} port {port}")
manifest = json.loads(pathlib.Path(fixtures).read_text())
for role in ("finished", "failed", "cancelled", "interrupted"):
    if role not in manifest.get("runs", {}):
        problems.append(f"fixtures.json has no runs.{role}")
if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"doctor ok {body['app']} pid={body['pid']} url=http://127.0.0.1:{port} home={home}")
print(f"fixtures finished={manifest['runs']['finished']} failed={manifest['runs']['failed']} cancelled={manifest['runs']['cancelled']} interrupted={manifest['runs']['interrupted']}")
PY
}

cmd_down() {
  [[ -f "$STATE" ]] || die "no instance record at $STATE"
  local pid shell_pid home log
  pid="$(read_state pid)"
  shell_pid="$(read_state shellPid)"
  home="$(read_state home)"
  log="$(read_state log)"
  if [[ "$pid" != "None" && -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  if [[ -n "$shell_pid" && "$shell_pid" != "$pid" ]]; then
    kill -TERM "$shell_pid" 2>/dev/null || true
  fi
  if [[ -f "$STATE_DIR/browser.json" ]]; then
    local browser_pid
    browser_pid="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",""))' "$STATE_DIR/browser.json")"
    if [[ -n "$browser_pid" && -r "/proc/$browser_pid/cmdline" ]] && tr '\0' ' ' <"/proc/$browser_pid/cmdline" | grep -q 'drive.py --serve'; then
      kill -TERM "$browser_pid" 2>/dev/null || true
    fi
    rm -f "$STATE_DIR/browser.json" "$STATE_DIR/browser.sock"
  fi
  if [[ -d "$home" ]]; then
    case "$home" in
      /tmp/verify-dashboard-home-*) rm -rf "$home" ;;
      *) die "refusing to delete home $home" ;;
    esac
  fi
  rm -f "$log" "$STATE"
  printf 'verify-dashboard: stopped pid %s and removed %s\n' "$pid" "$home"
}

usage() { die "usage: verify-dashboard.sh up|doctor|down"; }

case "${1:-}" in
  up) cmd_up ;;
  doctor) cmd_doctor ;;
  down) cmd_down ;;
  *) usage ;;
esac
