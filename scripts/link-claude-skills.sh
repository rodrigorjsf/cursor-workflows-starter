#!/usr/bin/env bash
# Expõe as skills de .agents/skills/ ao Claude Code, que não lê nada sob .agents/.
# Cria links simbólicos em .claude/skills/. Atenção: o Cursor também lê .claude/skills/ (compatibilidade),
# então a mesma skill pode aparecer duas vezes no Cursor. Rode só se o time usa Claude Code neste repositório.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .claude/skills
for dir in .agents/skills/*/; do
  name="$(basename "$dir")"
  target=".claude/skills/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "pulando $target (já existe e não é link)"; continue
  fi
  ln -sfn "../../.agents/skills/$name" "$target"
  echo "ok: $target -> .agents/skills/$name"
done
