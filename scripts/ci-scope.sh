#!/usr/bin/env bash
# WHAT: Reads the paths a change touches (one per line, on stdin) and prints which CI checks they justify, as
#   `docs_only=true|false` and `markdown=true|false` lines for $GITHUB_OUTPUT.
# WHY: The full suite runs four Node versions for minutes; a change to the book alone is covered by the repo-level tests,
#   and the Mermaid render (a headless Chromium) only matters when a changed Markdown file holds a Mermaid block, or the
#   checker changes. The required checks still report, because the jobs run and only skip steps: a skipped job would
#   leave a required check pending.
# WHEN: In CI, on a pull request, before the expensive steps. Locally, to see what a branch would run.
# HOW: `git diff --name-only origin/main... | scripts/ci-scope.sh`. An empty list (the diff failed) justifies everything.
set -euo pipefail

docs_only=true markdown=false seen=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  seen=yes
  case "$path" in
    # The book, the root guides and the license: no package test reads them; the repo-level tests check them.
    docs/* | LICENSE | .codegraph/*) ;;
    */*) docs_only=false ;;
    *.md) ;;
    *) docs_only=false ;;
  esac
  case "$path" in
    scripts/check-mermaid.ts | scripts/lib/markdown.ts | .github/workflows/ci.yml) markdown=true ;;
    # A Markdown file is rendered only when it holds a Mermaid block now; a deleted file or one without a block has
    # nothing to render.
    *.md) [ -f "$path" ] && grep -Eq '^[[:space:]]*(```|~~~)[[:space:]]*mermaid' "$path" && markdown=true ;;
  esac
done

# ponytail: no paths means the diff could not be read; run everything rather than guess.
[ -n "$seen" ] || { docs_only=false; markdown=true; }
echo "docs_only=$docs_only"
echo "markdown=$markdown"
