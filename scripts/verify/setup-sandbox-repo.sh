#!/usr/bin/env bash
# WHAT: Creates a private GitHub repo with a tiny Node project and one complexity:low issue, and prints the
#   implement-issue command to run on it.
# WHY: The end-to-end check of implement-issue (docs/research/verificacoes-locais.md section 9) needs a disposable
#   repo with a real issue.
# WHEN: Before an end-to-end run of implement-issue, including the Cursor IDE validation. Never against a repo you
#   care about.
# HOW: `scripts/verify/setup-sandbox-repo.sh <owner/new-repo> [local-dir]`; needs an authenticated `gh`.
#   GH_VISIBILITY=--public makes it public.

# Reproduz o teste ponta a ponta de docs/research/verificacoes-locais.md §9: um projeto Node mínimo, uma issue
# rotulada `complexity:low` e o comando exato do `implement-issue`.
#
# Uso: scripts/verify/setup-sandbox-repo.sh <dono/repositório-novo> [diretório-local]
#   Cria o repositório no GitHub (privado; use --public em GH_VISIBILITY para público), o rótulo e a issue.
#   Exige `gh` autenticado. O commit usa a identidade git local do repositório criado.
# shellcheck disable=SC2016 # crases literais em textos Markdown, sem expansão de propósito
set -euo pipefail

repo="${1:?usage: setup-sandbox-repo.sh <owner/new-repo> [local-dir]}"
dir="${2:-$HOME/tmp/$(basename "$repo")}"
visibility="${GH_VISIBILITY:---private}"
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [ -e "$dir" ]; then
  echo "error: $dir already exists" >&2
  exit 1
fi
mkdir -p "$dir/src" "$dir/test"
cd "$dir"

cat > package.json <<'JSON'
{
  "name": "wf-sandbox",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Throwaway repository for end-to-end tests of cursor-workflows-starter.",
  "scripts": { "test": "node --test" }
}
JSON
cat > src/math.js <<'JS'
export function add(a, b) {
  return a + b;
}
JS
cat > test/math.test.js <<'JS'
import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "../src/math.js";

test("add", () => {
  assert.equal(add(2, 3), 5);
});
JS
printf '# wf-sandbox\n\nThrowaway repository for end-to-end tests of `cursor-workflows-starter`. Nothing here is real code.\n' > README.md
printf 'node_modules/\n.workflows/\n' > .gitignore

git init -q -b main
git -c core.autocrlf=false add -A
git -c core.autocrlf=false commit -q -m "chore: minimal Node project with one test"
gh repo create "$repo" "$visibility" --description "Throwaway repository for end-to-end tests of cursor-workflows-starter" --source . --remote origin --push
gh label create "complexity:low" --color 0E8A16 --description "Small, mechanical change" -R "$repo"
issue_url=$(gh issue create -R "$repo" --title "Add subtract(a, b) to src/math.js" --label "complexity:low" \
  --body 'Add an exported function `subtract(a, b)` to `src/math.js` that returns `a - b`, and a test for it in `test/math.test.js`. Run the suite with `npm test`.')
issue="${issue_url##*/}"

cat <<MSG
Repository ready: $dir ($repo), issue #$issue.
The command measured in docs/research/verificacoes-locais.md section 9 (run it from $kit):
  WF_METRICS_DB=~/tmp/wf-verify.db npm run wf -- run implement-issue --cwd "$dir" \\
    --args '{"issue":$issue,"testCommand":"npm test","openPr":true}' --max-tokens 300000 --max-cents 50
And the resume, with the runId printed at the end:
  npm run wf -- run implement-issue --cwd "$dir" --args '{"issue":$issue,"testCommand":"npm test","openPr":true}' --resume <runId>
MSG
