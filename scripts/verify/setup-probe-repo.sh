#!/usr/bin/env bash
# WHAT: Builds a throwaway repo for the verify-* workflows: AGENTS.md with a marker word, Cursor and Claude Code
#   hooks, and an MCP config.
# WHY: The verify-* workflows measure what settingSources loads and what the recursion guard blocks; they need a repo
#   that has all of it.
# WHEN: Before running verify-structured, verify-context or verify-cache on a new account (see
#   scripts/verify/README.md).
# HOW: `scripts/verify/setup-probe-repo.sh <new-directory>`. Refuses a directory that already exists.

# Monta um repositório descartável para os workflows de scripts/verify/:
#   - AGENTS.md com uma palavra marcadora;
#   - .cursor/hooks.json (beforeShellExecution e postToolUse) que grava em .probe/cursor-hooks.log;
#   - .claude/settings.json com um PreToolUse que nega comandos com "proibido-pelo-claude" (exit 2);
#   - .cursor/mcp.json com o servidor `workflows` deste kit, gravando cada início em .probe/mcp-spawn.log.
# Uso: scripts/verify/setup-probe-repo.sh <diretório-novo>
set -euo pipefail

target="${1:?uso: setup-probe-repo.sh <diretório-novo>}"
kit="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [ -e "$target" ]; then
  echo "erro: $target já existe" >&2
  exit 1
fi
mkdir -p "$target"/{.cursor/hooks,.claude/hooks,.probe,src}
target="$(cd "$target" && pwd -P)"
cd "$target"

cat > AGENTS.md <<'MD'
# Instruções do projeto de teste

A palavra de verificação deste projeto é ORNITORRINCO-42. Quando alguém pedir a palavra de verificação, responda com ela.
MD
printf '{ "name": "wf-probe-repo", "version": "1.2.3", "private": true, "type": "module" }\n' > package.json
for i in 1 2 3; do printf 'export const valor%s = %s;\n' "$i" "$i" > "src/m$i.js"; done
{
  echo "# wf-probe-repo"
  echo
  for i in $(seq 1 120); do echo "Linha $i de texto de preenchimento para dar volume ao contexto lido pelas etapas de teste de cache do kit."; done
} > README.md

cat > .cursor/hooks.json <<'JSON'
{
  "version": 1,
  "hooks": {
    "postToolUse": [{ "command": ".cursor/hooks/log.sh" }],
    "beforeShellExecution": [{ "command": ".cursor/hooks/allow-shell.sh" }]
  }
}
JSON
cat > .cursor/hooks/log.sh <<'SH'
#!/bin/bash
in=$(cat)
ev=$(printf '%s' "$in" | grep -o '"hook_event_name":"[^"]*"' | head -1)
tool=$(printf '%s' "$in" | grep -o '"tool_name":"[^"]*"' | head -1)
echo "$(date -u +%FT%TZ) cursor $ev $tool" >> .probe/cursor-hooks.log
echo '{}'
SH
cat > .cursor/hooks/allow-shell.sh <<'SH'
#!/bin/bash
in=$(cat)
cmd=$(printf '%s' "$in" | grep -o '"command":"[^"]*"' | head -1)
echo "$(date -u +%FT%TZ) cursor beforeShellExecution $cmd" >> .probe/cursor-hooks.log
echo '{"permission":"allow"}'
SH
cat > .claude/settings.json <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": ".claude/hooks/deny-marker.sh" }] }
    ]
  }
}
JSON
cat > .claude/hooks/deny-marker.sh <<'SH'
#!/bin/bash
in=$(cat)
tool=$(printf '%s' "$in" | grep -o '"tool_name":"[^"]*"' | head -1)
echo "$(date -u +%FT%TZ) claude-PreToolUse $tool" >> .probe/claude-hooks.log
if printf '%s' "$in" | grep -q 'proibido-pelo-claude'; then
  echo "bloqueado pelo hook PreToolUse do Claude Code" >&2
  exit 2
fi
exit 0
SH
# JSON gerado pelo node: caminhos com espaço ou aspas ficam corretos; o shell do servidor lê os caminhos do env.
# shellcheck disable=SC2016 # aspas simples de propósito: o código JS não deve ser expandido pelo bash
KIT_DIR="$kit" PROBE_DIR="$target" node -e '
const { writeFileSync } = require("node:fs");
const cmd = "echo \"$(date -u +%FT%TZ) workflows-mcp-started inside=$WF_INSIDE_WORKFLOW\" >> \"$PROBE_DIR/.probe/mcp-spawn.log\"; " +
  "exec \"$KIT_DIR/node_modules/.bin/tsx\" \"$KIT_DIR/src/mcp-server.ts\"";
const env = { KIT_DIR: process.env.KIT_DIR, PROBE_DIR: process.env.PROBE_DIR, WF_CWD: "${workspaceFolder}", WF_METRICS: "off" };
writeFileSync(".cursor/mcp.json", JSON.stringify({ mcpServers: { workflows: { command: "/bin/sh", args: ["-c", cmd], env } } }, null, 2) + "\n");
'
chmod +x .cursor/hooks/*.sh .claude/hooks/*.sh
printf '.probe/\n.workflows/\n' > .gitignore
git init -q -b main
git -c core.autocrlf=false add -A
git -c user.name=probe -c user.email=probe@example.invalid -c core.autocrlf=false commit -q -m "probe repo"
echo "repositório de teste pronto em $target"
