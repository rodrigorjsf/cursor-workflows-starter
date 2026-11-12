# .agents/workflows/

Workflows **do repositório**. O runtime os carrega junto com os de `packages/runtime/workflows/` (os que vêm com o kit); em caso de
nome repetido, o daqui vence. Use esta pasta quando o kit estiver instalado fora do repositório (ver
`docs/usage/03-invocacao-no-cursor-ide.md`, forma B).

`.agents/` é um local neutro: o runtime é deste kit, não de um harness, então Cursor, Claude Code e Codex disparam os
mesmos workflows pelo MCP server.
