#!/usr/bin/env bash
# WHAT: Walks a person through the seven Cursor IDE validation scenarios: it creates a throwaway GitHub repo (with
#   setup-sandbox-repo.sh) and sets it up with `wf init`, runs `wf doctor` on it, says exactly what to type in the Cursor
#   chat for each scenario, records what the person saw, writes validation-report.json and offers to file it as an issue.
# WHY: "Works in the Cursor IDE" is the release criterion of the foundation spec, and seven scenarios that passed, recorded
#   the same way every time, are its evidence. The IDE's behaviour cannot be tested offline: a person has to look.
# WHEN: Before a release, on a new machine or account, and after a new Cursor version. Run it in Cursor's own terminal
#   (Terminal panel): scenario 1 counts only there, because the IDE picks its own Node and PATH.
# HOW: `scripts/verify/validate-cursor-ide.sh [report-dir]`, or `~/.cursor-workflows/kit/scripts/verify/validate-cursor-ide.sh`
#   for the installed kit. Needs `wf`, a logged-in `gh` and the kit's dependencies. Answers are kept in
#   `<report-dir>/progress.env` (default `~/.cursor-workflows/validation`), so Ctrl-C, or quitting Cursor in scenario 5,
#   loses nothing: run it again. `WF_KIT_REPO=owner/repo` files the issue somewhere other than the kit's origin;
#   `GH_VISIBILITY=--public` reaches the sandbox script. Scenarios 3 to 7 run workflows: about 800k tokens, on models the
#   plans include.
#
# The library below, down to the STAGES marker, is the /wizard skill's template.sh, unedited. The wizard's own helpers
# and stages follow the marker. Wizard text is English, like the library's; the report is English too.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: a sandbox repo, the seven scenarios (six of the foundation spec, the dashboard's of the live dashboard spec), and the report.
# ──────────────────────────────────────────────────────────────────────────

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT="$(cd "$HERE/../.." && pwd -P)"
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"
REPORT_DIR="${1:-${WF_HOME:-$HOME/.cursor-workflows}/validation}"
ENV_FILE="$REPORT_DIR/progress.env" # the library's value store: it keeps the answers across runs
TOTAL_STAGES=10

# ── Helpers of this wizard ────────────────────────────────────────────────

die() { printf '  %s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# record KEY VALUE saves a value in the progress file without announcing it.
record() { write_env "$1" "$2" >/dev/null; }

# ask_choice KEY "Prompt" CHOICE...: asks until the answer is a CHOICE or its first letter, then saves the whole CHOICE.
# Enter keeps an answer from an earlier run.
ask_choice() {
  local key="$1" prompt="$2" tries=0 answer choice options=""
  shift 2
  for choice in "$@"; do options+="${options:+, }$choice"; done
  while (( tries < 5 )); do
    tries=$((tries + 1))
    ask "$key" "$prompt"
    answer=$(printf '%s' "${!key}" | tr '[:upper:]' '[:lower:]')
    for choice in "$@"; do
      if [[ "$answer" == "$choice" || "$answer" == "${choice:0:1}" ]]; then
        printf -v "$key" '%s' "$choice"
        record "$key" "$choice"
        return 0
      fi
    done
    warn "Not understood. Answer one of: $options."
  done
  die "No valid answer to \"$prompt\" after $tries tries."
}

# ask_note N reads a one-line note for scenario N.
ask_note() {
  local key="S$1_NOTE"
  ask "$key" "What did you see? One line, Enter to skip:"
  record "$key" "${!key}"
}

# scenario_stage N "Title" opens the stage of scenario N and saves its title for the report.
scenario_stage() {
  stage "Scenario $1 of 7 · $2"
  record "S$1_TITLE" "$2"
}

# keep_recorded N is true when scenario N was answered in an earlier run and the person keeps that answer.
keep_recorded() {
  local result note reply=""
  result=$(_existing "S$1_RESULT") || return 1
  note=$(_existing "S$1_NOTE" || true)
  say "Already recorded: $result${note:+ · $note}"
  printf '  %s? Keep it and go on? [Y/n] ' "$YELLOW"
  read -r reply || true
  [[ ! "$reply" =~ ^[Nn] ]]
}

# kit_repo prints owner/name of the kit's GitHub repository: WF_KIT_REPO, else the origin of the kit checkout.
kit_repo() {
  if [[ -n "${WF_KIT_REPO:-}" ]]; then printf '%s' "$WF_KIT_REPO"; return 0; fi
  local url
  url=$(git -C "$KIT" remote get-url origin 2>/dev/null) || return 1
  [[ "$url" =~ github\.com[:/]([^/]+/[^/]+)$ ]] || return 1
  url="${BASH_REMATCH[1]}"
  printf '%s' "${url%.git}"
}

# sandbox_issue "Title" "Body" adds a complexity:low issue to the sandbox repo, for a scenario that needs its own run.
sandbox_issue() {
  gh issue create -R "$SANDBOX_REPO" --title "$1" --label "complexity:low" --body "$2" >/dev/null \
    || die "Could not create an issue on $SANDBOX_REPO."
}

# ── Before the first stage ────────────────────────────────────────────────

command -v wf >/dev/null 2>&1 || die "wf is not on the PATH. Install the kit with INSTALL-AGENT.md, or put ~/.local/bin on the PATH."
command -v gh >/dev/null 2>&1 || die "gh is not installed (https://cli.github.com)."
gh auth status >/dev/null 2>&1 || die "gh is not logged in: run gh auth login."
[[ -x "$KIT/node_modules/.bin/tsx" ]] || die "The kit's dependencies are missing in $KIT: run npm ci there (wf doctor says the same)."
mkdir -p "$REPORT_DIR"

banner "Cursor IDE validation"

# ── Stage 1 ───────────────────────────────────────────────────────────────
stage "Check the machine"
say "Kit: $KIT"
say "wf:  $(command -v wf)"
say "Your answers and the report go to $REPORT_DIR"
note "Run this wizard in Cursor's own terminal (Terminal panel): the IDE picks its own Node and PATH, and scenario 1 is about those."
ask CURSOR_VERSION "Cursor version (Help > About; Enter to skip):"
record CURSOR_VERSION "$CURSOR_VERSION"
ask_choice IDE_TERMINAL "Is this terminal inside Cursor? (yes/no):" yes no

# ── Stage 2 ───────────────────────────────────────────────────────────────
stage "Sandbox repo"
if SANDBOX_DIR=$(_existing SANDBOX_DIR) && [[ -d "$SANDBOX_DIR" ]]; then
  SANDBOX_REPO=$(_existing SANDBOX_REPO)
  say "Reusing the sandbox of the earlier run: $SANDBOX_REPO, in $SANDBOX_DIR"
else
  say "Scenarios 3 to 7 run workflows on a throwaway repository with issues to implement."
  ask SANDBOX_REPO "Name of the new repository (owner/name):"
  [[ "$SANDBOX_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "Expected owner/name, got \"$SANDBOX_REPO\"."
  SANDBOX_DIR="$HOME/tmp/${SANDBOX_REPO##*/}"
  visibility="${GH_VISIBILITY:---private}" # the sandbox script's own default and variable
  confirm "Create the ${visibility#--} repository $SANDBOX_REPO on GitHub, with 3 issues, and $SANDBOX_DIR here?" \
    || { say "Nothing was created. Run the wizard again when you are ready."; exit 0; }
  # The existing script makes the repo and issue 1; it refuses a folder that exists.
  bash "$HERE/setup-sandbox-repo.sh" "$SANDBOX_REPO" "$SANDBOX_DIR" \
    || die "The sandbox script failed (above). If it got as far as creating the repository, delete it (gh repo delete $SANDBOX_REPO) and remove $SANDBOX_DIR, then run the wizard again."
  record SANDBOX_REPO "$SANDBOX_REPO" # from here on a rerun picks the sandbox up where this stage stops
  record SANDBOX_DIR "$SANDBOX_DIR"
fi
if [[ "$(_existing SANDBOX_ISSUES || true)" != yes ]]; then
  # shellcheck disable=SC2016 # backticks are Markdown here, not command substitution
  sandbox_issue "Add multiply(a, b) to src/math.js" 'Add an exported function `multiply(a, b)` to `src/math.js` that returns `a * b`, and a test for it in `test/math.test.js`. Run the suite with `npm test`.'
  # shellcheck disable=SC2016
  sandbox_issue "Add negate(a) to src/math.js" 'Add an exported function `negate(a)` to `src/math.js` that returns `-a`, and a test for it in `test/math.test.js`. Run the suite with `npm test`.'
  record SANDBOX_ISSUES yes
fi
say "Setting the sandbox up for the kit: wf init (it commits nothing)."
wf init --cwd "$SANDBOX_DIR" >/dev/null || die "wf init failed in $SANDBOX_DIR. Fix that and run the wizard again: the repository and its issues are already there."
if [[ "$(_existing SANDBOX_READY || true)" != yes ]]; then
  step "Open $SANDBOX_DIR as a folder in Cursor (File > Open Folder). Scenarios 2 to 6 happen in that window."
  pause "Press Enter when the folder is open."
  record SANDBOX_READY yes
fi

# ── Stage 3 · scenario 1 ──────────────────────────────────────────────────
scenario_stage 1 "doctor is green in the IDE's environment"
say "Running wf doctor on the sandbox from this terminal."
wf doctor --cwd "$SANDBOX_DIR" || true
if wf doctor --json --cwd "$SANDBOX_DIR" > "$REPORT_DIR/doctor.json" 2>/dev/null; then doctor_exit=0; else doctor_exit=$?; fi
if [[ "$IDE_TERMINAL" != yes ]]; then
  record S1_RESULT skip
  record S1_NOTE "The wizard ran outside Cursor's terminal, so the IDE's own Node and PATH were not tested (wf doctor exit $doctor_exit)."
  warn "Scenario 1 is skipped: this terminal is outside Cursor. Run the wizard from Cursor's Terminal panel to cover it."
elif (( doctor_exit == 0 )); then
  record S1_RESULT pass
  record S1_NOTE "wf doctor exited 0 in Cursor's terminal."
else
  record S1_RESULT fail
  record S1_NOTE "wf doctor exited $doctor_exit in Cursor's terminal."
  warn "Scenario 1 failed: fix what the report says (each failure has a hint), then run the wizard again."
fi
pause "Press Enter to go on."

# ── Stage 4 · scenario 2 ──────────────────────────────────────────────────
scenario_stage 2 "the MCP server is visible and enabled"
if ! keep_recorded 2; then
  step "In the Cursor window of the sandbox, open the MCP list (Customize)."
  step "The server  workflows  must be listed and switched on, with five tools:"
  say "    list_workflows, start_workflow, wait_workflow, get_workflow_status, cancel_workflow"
  note "If it is off or red, the Output panel (MCP Logs) says why."
  pause "Press Enter when you have looked."
  ask_choice S2_RESULT "Result: pass, fail or skip?" pass fail skip
  ask_note 2
fi

# ── Stage 5 · scenario 3 ──────────────────────────────────────────────────
scenario_stage 3 "/run-workflow smoke finished"
if ! keep_recorded 3; then
  step "In a new Agent chat of the sandbox window, type:"
  say "    /run-workflow smoke"
  note "One agent step on composer-2.5, capped at 50k tokens."
  note "Pass: the chat reports the job finished, with the answer pong."
  pause "Press Enter when the chat has answered."
  ask_choice S3_RESULT "Result: pass, fail or skip?" pass fail skip
  ask_note 3
fi

# ── Stage 6 · scenario 4 ──────────────────────────────────────────────────
scenario_stage 4 "implement-issue LOW opens a PR on the sandbox repo"
if ! keep_recorded 4; then
  step "In the same chat, type:"
  say "    /run-workflow implement-issue 1, and open the pull request (openPr: true)"
  note "implement-issue opens no PR unless asked. It takes some minutes and about 340k tokens (measured: 339k)."
  pause "Press Enter when the chat reports the job finished (or failed)."
  open_url "https://github.com/$SANDBOX_REPO/pulls"
  say "What wf reports for the jobs of the sandbox:"
  wf jobs --cwd "$SANDBOX_DIR" || true
  say "GitHub lists these pull requests on $SANDBOX_REPO:"
  gh pr list -R "$SANDBOX_REPO" || true
  note "Pass: the job is finished and one pull request exists."
  ask_choice S4_RESULT "Result: pass, fail or skip?" pass fail skip
  ask_note 4
fi

# ── Stage 7 · scenario 5 ──────────────────────────────────────────────────
scenario_stage 5 "resume after restarting Cursor mid-run"
if ! keep_recorded 5; then
  if [[ "$(_existing S5_STARTED || true)" != yes ]]; then
    step "In a new chat of the sandbox window, type:"
    say "    /run-workflow implement-issue 2"
    step "Wait until the chat shows the jobId and the job is running. Write the jobId down."
    ask S5_JOB "jobId (Enter if the chat showed none):"
    record S5_JOB "$S5_JOB"
    if [[ "$IDE_TERMINAL" == yes ]]; then
      record S5_STARTED yes
      step "Now quit Cursor completely, not only the window, while the job runs. It runs in its own process and must outlive Cursor."
      step "Reopen Cursor on $SANDBOX_DIR, open its Terminal panel and run this wizard again:"
      say "    $SELF"
      note "Quitting Cursor closes this terminal, so this is where the wizard stops. It remembers what you answered."
      exit 0
    fi
    step "Quit Cursor completely, not only the window, while the job runs, and reopen it on $SANDBOX_DIR."
    pause "Press Enter when Cursor is back."
  else
    say "Welcome back. Cursor was restarted while the job ran."
  fi
  S5_JOB=$(_existing S5_JOB || true)
  if [[ -n "$S5_JOB" ]]; then
    say "What wf reports for job $S5_JOB:"
    wf status "$S5_JOB" --cwd "$SANDBOX_DIR" || true
    step "In a new chat, type:"
    say "    What is the state of workflow job $S5_JOB?"
    step "To wait for the job from a terminal instead, repeat until it is no longer running:"
    say "    wf wait $S5_JOB --cwd $SANDBOX_DIR"
  else
    step "In a new chat, ask for the state of the job you started (get_workflow_status)."
  fi
  note "Pass: the job ends finished although Cursor was restarted while it ran. A job still running is not a pass yet: wait for it."
  step "If it failed instead (the chat shows a runId), type:"
  say "    /run-workflow implement-issue 2, resuming run <runId> (resumeRunId)"
  note "Pass then: the resumed run finishes without repeating the steps that had finished."
  ask_choice S5_RESULT "Result: pass, fail or skip?" pass fail skip
  ask_note 5
fi

# ── Stage 8 · scenario 6 ──────────────────────────────────────────────────
scenario_stage 6 "cancel from the chat"
if ! keep_recorded 6; then
  step "In a chat of the sandbox window, type:"
  say "    /run-workflow implement-issue 3"
  step "When the chat shows the job running, type:"
  say "    cancel the workflow"
  note "Pass: the job ends cancelled, and the chat gives its runId (the run can be resumed)."
  pause "Press Enter when the chat has answered."
  say "What wf reports for the jobs of the sandbox:"
  wf jobs --cwd "$SANDBOX_DIR" || true
  ask_choice S6_RESULT "Result: pass, fail or skip?" pass fail skip
  ask_note 6
fi

# ── Stage 9 · scenario 7 ──────────────────────────────────────────────────
scenario_stage 7 "the dashboard shows the run live"
if ! keep_recorded 7; then
  step "In a chat of the sandbox window, type:"
  say "    /run-workflow smoke"
  note "The chat starts the run, gives the dashboard link (http://127.0.0.1:${WF_DASH_PORT:-4317}) and opens it in Cursor's built-in browser. Open the link there yourself if the chat did not."
  step "On the Board, look at the smoke board:"
  say "    - a card for the run is in the Ping column while it runs, and moves to Done by itself, without reloading the page."
  step "Click the card. The Run view opens:"
  say "    - the graph draws the ping step: it pulses while the step runs and turns green when it ends."
  say "    - hover the step: its model, location, attempts, tokens, cost and duration appear."
  say "    - click the step: its log opens beside the graph, with the prompt, what the agent said and its tool calls."
  note "Pass: all of this works in Cursor's built-in browser. If not, note what you saw (a blank page, an address that was refused, a card that never moved)."
  pause "Press Enter when you have looked."
  ask_choice S7_RESULT "Result: pass, fail or skip?" pass fail skip
  ask_note 7
fi

# ── Stage 10 · report ─────────────────────────────────────────────────────
stage "Report"
doctor_args=()
[[ -s "$REPORT_DIR/doctor.json" ]] && doctor_args=(--doctor "$REPORT_DIR/doctor.json")
title=$(TSX_TSCONFIG_PATH="$KIT/tsconfig.json" "$KIT/node_modules/.bin/tsx" "$HERE/validation-report.ts" \
  --progress "$ENV_FILE" --out-dir "$REPORT_DIR" --kit "$KIT" ${doctor_args[@]+"${doctor_args[@]}"}) \
  || die "Could not build the report from $ENV_FILE. The node on the PATH may be too old for the kit: wf doctor says."
say "$title"
say "Written to $REPORT_DIR/validation-report.json (local paths and repository names are anonymized)."
printf '\n'
say "The issue would say:"
printf '\n'
sed 's/^/    /' "$REPORT_DIR/issue-body.md"
printf '\n'
if kit_slug=$(kit_repo); then
  if confirm "File this as an issue on $kit_slug?"; then
    url=$(gh issue create -R "$kit_slug" --title "$title" --body-file "$REPORT_DIR/issue-body.md") || die "gh could not create the issue."
    say "Filed: $url"
  else
    note "Not filed. The report stays in $REPORT_DIR."
  fi
else
  note "No GitHub origin found for the kit: send $REPORT_DIR/validation-report.json to its maintainer."
fi
mv "$ENV_FILE" "$REPORT_DIR/progress-$(date +%Y%m%d-%H%M%S).env" # the next validation starts clean
printf '\n%s%s  ✓ Validation recorded%s\n\n' "$BOLD" "$GREEN" "$RESET"
