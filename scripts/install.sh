#!/usr/bin/env bash
# WHAT: Installs the kit for the current user: clones it at a release tag into ~/.cursor-workflows/kit, installs its
#   dependencies, writes the `wf` shim, links the distributed skills into ~/.claude/skills/ and writes the default global
#   config if there is none.
# WHY: One install per machine, pinned to a tag, that every repo's committed MCP config can name (`${userHome}`), so an
#   agent can install the kit from INSTALL-AGENT.md without manual steps.
# WHEN: Once per machine (INSTALL-AGENT.md drives it), and with `--dev` by a maintainer who wants the kit location to be
#   a working copy. `wf upgrade` runs it with `--refresh`.
# HOW: `bash install.sh --tag vX.Y.Z [--repo <url>] [--allow-mutable-tag]`, `scripts/install.sh --dev`, or
#   `install.sh --refresh` (dependencies, shim, skill links and config for the kit already in place). Safe to run again.
#   WF_HOME replaces ~/.cursor-workflows. An existing clone with local changes is refused, not moved: reinstall it
#   (docs/usage/01-instalacao.md). A tag install refuses a tag that moved upstream and a release that is not immutable
#   (GitHub's `immutable` field), because a tag someone can move makes every later install run their code;
#   --allow-mutable-tag skips the release check, for a fork given with --repo (the check covers only the official repository).
#   WF_GITHUB_API_URL (tests only) replaces https://api.github.com.

# Everything runs inside main(), called on the last line: bash reads a function whole before running it, so a
# half-downloaded script (curl | bash) does nothing, and `wf upgrade` can check out a new install.sh under a running one.
main() {
  set -euo pipefail
  # What the installer creates (~/.cursor-workflows, its config, the kit) is for this user alone: the usual umask would let every local user
  # read it. A file or folder that already exists keeps its mode.
  umask 077

  # Same repository as KIT_REPO in packages/runtime/src/kit-version.ts; test/install-guide.test.ts keeps them equal.
  local default_repo="https://github.com/rodrigorjsf/cursor-workflows-starter.git"
  local tag="" repo="$default_repo" repo_given="" mode="" allow_mutable=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:?--tag needs a value, for example --tag v0.3.0}"; mode="tag"; shift 2 ;;
      --repo) repo="${2:?--repo needs a value}"; repo_given="yes"; shift 2 ;;
      --allow-mutable-tag) allow_mutable="yes"; shift ;;
      --dev) mode="dev"; shift ;;
      --refresh) mode="refresh"; shift ;;
      -h|--help) usage; return 0 ;;
      *) echo "error: unknown option: $1" >&2; usage >&2; return 2 ;;
    esac
  done
  [ -n "$mode" ] || { usage >&2; return 2; }
  [ -z "$allow_mutable" ] || [ "$mode" = "tag" ] || { echo "error: --allow-mutable-tag skips the release check of a tag install, so it only goes with --tag" >&2; return 2; }

  local wf_dir="${WF_HOME:-$HOME/.cursor-workflows}"
  local kit="$wf_dir/kit"
  local bin_dir="$HOME/.local/bin"
  local skills_dir="$HOME/.claude/skills"

  for tool in git npm node; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not on the PATH; install it and run again"
  done

  mkdir -p "$wf_dir"
  case "$mode" in
    tag) fetch_kit "$kit" "$tag" "$repo" "$repo_given" "$allow_mutable" "$default_repo" ;;
    dev) link_working_copy "$kit" "${BASH_SOURCE[0]:-}" ;;
    refresh) [ -d "$kit" ] || die "no kit at $kit; install one with --tag vX.Y.Z (or --dev)" ;;
  esac

  check_node "$kit"
  install_dependencies "$kit"
  write_shim "$kit" "$bin_dir"
  link_skills "$kit" "$skills_dir"
  write_default_config "$kit" "$wf_dir"
  echo "kit ready at $kit"
}

usage() {
  echo "usage: install.sh --tag vX.Y.Z [--repo <url>] [--allow-mutable-tag] | --dev | --refresh"
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warning: $*" >&2
}

# Dies unless the clone at $1 has a clean tree. `git checkout` keeps a tracked file that the old and the new tag share, and every
# untracked file, and `npm ci` then reads an .npmrc planted in the clone: a step that can write to the kit could make the
# install run its code, so a kit with local changes is reinstalled, not moved. Mirrors `kitChanges` in
# packages/runtime/src/kit-state.ts: the changes are listed as `git status --porcelain` prints them, ignored files (a planted
# .npmrc can sit in .git/info/exclude) included, and the kit's own node_modules/ is the one ignored thing left out.
require_clean_kit() {
  local kit="$1" status changes
  status="$(git -C "$kit" status --porcelain --untracked-files=all --ignored=matching)" || die "could not read the state of the kit at $kit; reinstall it"
  changes="$(printf '%s\n' "$status" | grep -v -E '^!! (.*/)?node_modules/$' || true)"
  [ -z "$changes" ] ||
    die "the kit at $kit has local changes: $(printf '%s\n' "$changes" | awk 'NR > 1 { printf ", " } { sub(/^ +/, ""); printf "%s", $0 }'); reinstall it"
}

# Puts the kit at $kit on the tag: clones it, or moves an existing clone to the tag. A kit location that is a link is a dev
# install: it points at somebody's working copy, which this script must not check out. An existing clone must have no local
# changes, and fetches from its own origin (as configured, whatever a user's url.<base>.insteadOf rewrites it to); a --repo
# given on the command line replaces that origin first. The release of the tag must be immutable (see
# require_immutable_release) before the clone is touched, and the tags are fetched without --force, so a tag that exists in
# the clone and moved upstream fails the fetch instead of being overwritten.
fetch_kit() {
  local kit="$1" tag="$2" repo="$3" repo_given="$4" allow_mutable="$5" official="$6" origin="$3" fetch_err
  [ ! -L "$kit" ] || die "$kit is a development install (it points to $(readlink "$kit")); remove the link to install a tag"
  if [ -d "$kit/.git" ]; then
    require_clean_kit "$kit"
    [ -n "$repo_given" ] || origin="$(git -C "$kit" config --get remote.origin.url)" || die "the clone at $kit has no origin remote"
    [ -n "$allow_mutable" ] || require_immutable_release "$official" "$origin" "$tag"
    [ -z "$repo_given" ] || git -C "$kit" remote set-url origin "$repo"
    # Not --quiet: it also hides the line that names a rejected tag. The output is held, and shown only on failure.
    # LC_ALL=C: the check below reads git's own words, which a translated git would not say the same way.
    if ! fetch_err="$(LC_ALL=C git -C "$kit" fetch --tags 2>&1)"; then
      [ -z "$fetch_err" ] || printf '%s\n' "$fetch_err" >&2
      case "$fetch_err" in
        *"would clobber existing tag"*) die "a release tag of $origin moved upstream since this kit fetched it: git refuses to overwrite the local tag (see above), and the kit stays as it is. Do not install until the repository owner explains the move" ;;
        *) die "could not fetch the tags of $origin" ;;
      esac
    fi
    git -C "$kit" -c advice.detachedHead=false checkout --quiet "$tag" || die "tag $tag does not exist in $kit"
  else
    [ -n "$allow_mutable" ] || require_immutable_release "$official" "$origin" "$tag"
    git -c advice.detachedHead=false clone --quiet --branch "$tag" "$repo" "$kit" || die "could not clone $repo at tag $tag"
  fi
}

# Stops unless the GitHub release of $tag says `immutable: true`. An immutable release locks its tag to its commit, so
# whoever steals a token cannot move the tag to code that every later install then runs. The release API needs no token.
# Only the official repository ($official) is covered, so any other $origin is refused too: the answer for a tag of the
# same name in another repository would say nothing about that one. A release that is missing, one that is not
# immutable and a call that fails are all errors, never a skip: --allow-mutable-tag is the one explicit skip. Needs `node`
# for the HTTP call and the JSON, which the install requires anyway.
require_immutable_release() {
  local official="$1" origin="$2" tag="$3" api="${WF_GITHUB_API_URL:-https://api.github.com}" lookup_timeout_ms=20000 want got slug url verdict
  want="${official%/}"
  got="${origin%/}"
  [ "${got%.git}" = "${want%.git}" ] || die "the release check covers only $official, and this kit's origin is $origin. Pass --allow-mutable-tag to install from it without the check"
  case "$tag" in
    ""|*[!A-Za-z0-9._-]*) die "tag \"$tag\" is not a plain tag name (letters, digits, dots, dashes and underscores), so its release cannot be looked up. Pass --allow-mutable-tag to install it without the check" ;;
  esac
  slug="${official#https://github.com/}"
  slug="${slug%.git}"
  url="$api/repos/$slug/releases/tags/$tag"
  verdict="$(node -e '
    const say = (word) => console.log(word);
    if (typeof fetch !== "function") { say("oldnode"); process.exit(0); }
    fetch(process.argv[1], { headers: { accept: "application/vnd.github+json", "user-agent": "cursor-workflows-installer" }, signal: AbortSignal.timeout(Number(process.argv[2])) })
      .then(async (res) => {
        if (res.status === 404) return say("missing");
        if (!res.ok) return say("unreachable HTTP " + res.status);
        say((await res.json()).immutable === true ? "immutable" : "mutable");
      })
      .catch((err) => say("unreachable " + (err.cause?.message || err.cause?.code || err.message)));
  ' "$url" "$lookup_timeout_ms")" || verdict="unreachable node failed"
  case "$verdict" in
    immutable) ;;
    mutable) die "the release $tag of $slug is not immutable, so its tag may have been moved to other code. Install an immutable release, or pass --allow-mutable-tag to install it anyway" ;;
    oldnode) die "the node on the PATH ($(node --version)) is too old to look up the release of $tag, and the kit needs a newer one still. Install a newer Node, put it on the PATH and run again, or pass --allow-mutable-tag to skip the check" ;;
    missing) die "$slug has no release for tag $tag, and only a published release installs. Install a released tag, or pass --allow-mutable-tag to install this one anyway" ;;
    *) die "could not read the release of $tag from $url (${verdict#unreachable }). Check the network and run again, or pass --allow-mutable-tag to skip the check" ;;
  esac
}

# Makes the kit location a link to the working copy that holds this script. A real kit already there is left alone.
link_working_copy() {
  local kit="$1" self="$2"
  [ -f "$self" ] || die "--dev must run from a file inside the clone: scripts/install.sh --dev"
  [ ! -e "$kit" ] || [ -L "$kit" ] || die "$kit is already a tag install; move it aside and run again"
  ln -sfn "$(cd "$(dirname "$self")/.." && pwd -P)" "$kit"
}

# The kit needs the Node its package.json asks for; the version is read from the `node` the PATH gives, the one the IDE
# is likeliest to use too.
check_node() {
  local need have
  need="$(sed -n 's/.*"node": *">=\([0-9][0-9.]*\)".*/\1/p' "$1/package.json" | head -n 1)"
  have="$(node --version)"
  have="${have#v}"
  [ -z "$need" ] || [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -n 1)" = "$need" ] ||
    die "Node $have ($(command -v node)) is too old: the kit needs $need or newer. Install a newer Node, put it on the PATH and run again"
}

# A tag install gets the lockfile's exact tree. A dev install (the kit location links to a working copy) is the
# maintainer's: `npm ci` would empty its node_modules, so it only gets what is missing. Neither runs a dependency's
# lifecycle scripts: the kit's .npmrc says so too, and the flag keeps it so if that file is edited (a compromised
# dependency then has no install-time code to run on this machine).
install_dependencies() {
  local kit="$1"
  if [ -L "$kit" ]; then
    [ -x "$kit/node_modules/.bin/tsx" ] || (cd "$kit" && npm install --ignore-scripts --no-audit --no-fund)
  else
    (cd "$kit" && npm ci --ignore-scripts --no-audit --no-fund)
  fi
}

# $1 as one word for a POSIX shell: in single quotes, each ' written as '\''.
sh_quote() {
  local escaped="'\\''"
  printf "'%s'" "${1//\'/$escaped}"
}

# The `wf` command: runs the CLI of whatever kit is at $kit. A `wf` the user already has, that this script did not write,
# is left alone. The folder must be on the PATH for the command to be found; the script says so when it is not.
write_shim() {
  local kit="$1" bin_dir="$2" shim="$2/wf"
  if [ -e "$shim" ] && ! grep -q '^# cursor-workflows shim' "$shim"; then
    warn "skipping $shim: a wf that is not the kit's is already there; rename it and run again"
    return 0
  fi
  mkdir -p "$bin_dir"
  printf '#!/bin/sh\n# cursor-workflows shim, written by install.sh.\nexec %s %s "$@"\n' "$(sh_quote "$kit/node_modules/.bin/tsx")" "$(sh_quote "$kit/packages/runtime/src/cli.ts")" > "$shim.tmp"
  chmod +x "$shim.tmp"
  mv -f "$shim.tmp" "$shim"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on the PATH, so the wf command will not be found. bash/zsh: export PATH=\"$bin_dir:\$PATH\" in ~/.profile. fish: fish_add_path $bin_dir" ;;
  esac
}

# Links each skill of the kit into the global skills folder (Claude Code reads it, and so does Cursor), through the fixed
# kit location, so a link stays valid when the kit moves between a tag and a working copy. Only links that point into the
# kit are touched: a skill folder or a link of the user's is left alone. Links to skills the kit no longer ships are removed.
link_skills() {
  local kit="$1" skills_dir="$2" dir name link
  mkdir -p "$skills_dir"
  for dir in "$kit"/skills/*/; do
    [ -f "$dir/SKILL.md" ] || continue
    name="$(basename "$dir")"
    link="$skills_dir/$name"
    if [ -L "$link" ]; then
      case "$(readlink "$link")" in
        "$kit/skills/"*) ;;
        *) warn "skipping $link: it is a link to somewhere else"; continue ;;
      esac
    elif [ -e "$link" ]; then
      warn "skipping $link: it already exists and is not a link"
      continue
    fi
    ln -sfn "$kit/skills/$name" "$link"
  done
  for link in "$skills_dir"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$kit/skills/"*) [ -f "$link/SKILL.md" ] || { rm "$link"; echo "removed $link: the kit no longer ships that skill"; } ;;
    esac
  done
}

# The caps every run is held to, from the kit's template. A config the user already has is theirs and stays.
write_default_config() {
  local kit="$1" wf_dir="$2"
  [ -e "$wf_dir/config.json" ] || cp "$kit/templates/global-config.json" "$wf_dir/config.json"
}

main "$@"
exit $?
