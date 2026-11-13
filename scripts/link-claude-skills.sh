#!/usr/bin/env bash
# WHAT: Symlinks every skill in .agents/skills/ into .claude/skills/, which Claude Code reads (it does not read
#   .agents/).
# WHY: The kit keeps its skills in the neutral .agents/ folder, but only .cursor/ and .claude/ are read by their own
#   harness.
# WHEN: Once per clone, and only if the team uses Claude Code here: Cursor also reads .claude/skills/, so a skill may
#   then appear twice in Cursor.
# HOW: `scripts/link-claude-skills.sh`, from any directory. Idempotent; it skips a target that exists and is not a
#   link.

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
    echo "skipping $target (it exists and is not a link)"; continue
  fi
  ln -sfn "../../.agents/skills/$name" "$target"
  echo "ok: $target -> .agents/skills/$name"
done
