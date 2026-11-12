#!/usr/bin/env bash
# WHAT: Installs the kit for the current user: clones it at a release tag into ~/.cursor-workflows/kit, installs its
#   dependencies, writes the `wf` shim, links the distributed skills into ~/.claude/skills/ and writes the default global
#   config if there is none.
# WHY: One install per machine, pinned to a tag, that every repo's committed MCP config can name (`${userHome}`), so an
#   agent can install the kit from INSTALL-AGENT.md without manual steps.
# WHEN: Once per machine (INSTALL-AGENT.md drives it), and with `--dev` by a maintainer who wants the kit location to be
#   a working copy. `wf upgrade` runs it with `--refresh`.
# HOW: `bash install.sh --tag vX.Y.Z [--repo <url>]`, `scripts/install.sh --dev`, or `install.sh --refresh` (dependencies,
#   shim, skill links and config for the kit already in place). Safe to run again. WF_HOME replaces ~/.cursor-workflows.

# Everything runs inside main(), called on the last line: bash reads a function whole before running it, so a
# half-downloaded script (curl | bash) does nothing, and `wf upgrade` can check out a new install.sh under a running one.
main() {
  set -euo pipefail

  # Same repository as KIT_REPO in packages/runtime/src/kit-version.ts; test/install-guide.test.ts keeps them equal.
  local default_repo="https://github.com/rodrigorjsf/cursor-workflows-starter.git"
  local tag="" repo="$default_repo" repo_given="" mode=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag) tag="${2:?--tag precisa de um valor, por exemplo --tag v0.3.0}"; mode="tag"; shift 2 ;;
      --repo) repo="${2:?--repo precisa de um valor}"; repo_given="yes"; shift 2 ;;
      --dev) mode="dev"; shift ;;
      --refresh) mode="refresh"; shift ;;
      -h|--help) usage; return 0 ;;
      *) echo "erro: opção desconhecida: $1" >&2; usage >&2; return 2 ;;
    esac
  done
  [ -n "$mode" ] || { usage >&2; return 2; }

  local wf_dir="${WF_HOME:-$HOME/.cursor-workflows}"
  local kit="$wf_dir/kit"
  local bin_dir="$HOME/.local/bin"
  local skills_dir="$HOME/.claude/skills"

  for tool in git npm node; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool não está no PATH; instale-o e rode de novo"
  done

  mkdir -p "$wf_dir"
  case "$mode" in
    tag) fetch_kit "$kit" "$tag" "$repo" "$repo_given" ;;
    dev) link_working_copy "$kit" "${BASH_SOURCE[0]:-}" ;;
    refresh) [ -d "$kit" ] || die "não há kit em $kit; instale com --tag vX.Y.Z (ou --dev)" ;;
  esac

  check_node "$kit"
  install_dependencies "$kit"
  write_shim "$kit" "$bin_dir"
  link_skills "$kit" "$skills_dir"
  write_default_config "$kit" "$wf_dir"
  echo "kit pronto em $kit"
}

usage() {
  echo "uso: install.sh --tag vX.Y.Z [--repo <url>] | --dev | --refresh"
}

die() {
  echo "erro: $*" >&2
  exit 1
}

warn() {
  echo "aviso: $*" >&2
}

# Puts the kit at $kit on the tag: clones it, or moves an existing clone to the tag. A kit location that is a link is a dev
# install: it points at somebody's working copy, which this script must not check out. An existing clone fetches from
# its own origin; a --repo given on the command line replaces that origin first.
fetch_kit() {
  local kit="$1" tag="$2" repo="$3" repo_given="$4"
  [ ! -L "$kit" ] || die "$kit é uma instalação de desenvolvimento (aponta para $(readlink "$kit")); remova o link para instalar uma tag"
  if [ -d "$kit/.git" ]; then
    [ -z "$repo_given" ] || git -C "$kit" remote set-url origin "$repo"
    git -C "$kit" fetch --quiet --tags --force || die "não consegui buscar as tags de $(git -C "$kit" remote get-url origin)"
    git -C "$kit" -c advice.detachedHead=false checkout --quiet "$tag" || die "a tag $tag não existe em $kit"
  else
    git -c advice.detachedHead=false clone --quiet --branch "$tag" "$repo" "$kit" || die "não consegui clonar $repo na tag $tag"
  fi
}

# Makes the kit location a link to the working copy that holds this script. A real kit already there is left alone.
link_working_copy() {
  local kit="$1" self="$2"
  [ -f "$self" ] || die "--dev precisa rodar de um arquivo, dentro do clone: scripts/install.sh --dev"
  [ ! -e "$kit" ] || [ -L "$kit" ] || die "$kit já é uma instalação de uma tag; mova-o para trás e rode de novo"
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
    die "o Node $have ($(command -v node)) é antigo demais: o kit exige $need ou mais novo. Instale um Node mais novo, coloque-o no PATH e rode de novo"
}

# A tag install gets the lockfile's exact tree. A dev install (the kit location links to a working copy) is the
# maintainer's: `npm ci` would empty its node_modules, so it only gets what is missing.
install_dependencies() {
  local kit="$1"
  if [ -L "$kit" ]; then
    [ -x "$kit/node_modules/.bin/tsx" ] || (cd "$kit" && npm install --no-audit --no-fund)
  else
    (cd "$kit" && npm ci --no-audit --no-fund)
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
    warn "pulando $shim: já existe um wf que não é do kit; renomeie-o e rode de novo"
    return 0
  fi
  mkdir -p "$bin_dir"
  printf '#!/bin/sh\n# cursor-workflows shim, written by install.sh.\nexec %s %s "$@"\n' "$(sh_quote "$kit/node_modules/.bin/tsx")" "$(sh_quote "$kit/packages/runtime/src/cli.ts")" > "$shim.tmp"
  chmod +x "$shim.tmp"
  mv -f "$shim.tmp" "$shim"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir não está no PATH, então o comando wf não será achado. bash/zsh: export PATH=\"$bin_dir:\$PATH\" no ~/.profile. fish: fish_add_path $bin_dir" ;;
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
        *) warn "pulando $link: é um link para outro lugar"; continue ;;
      esac
    elif [ -e "$link" ]; then
      warn "pulando $link: já existe e não é um link"
      continue
    fi
    ln -sfn "$kit/skills/$name" "$link"
  done
  for link in "$skills_dir"/*; do
    [ -L "$link" ] || continue
    case "$(readlink "$link")" in
      "$kit/skills/"*) [ -f "$link/SKILL.md" ] || { rm "$link"; echo "removi $link: a skill saiu do kit"; } ;;
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
