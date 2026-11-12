// Falha cedo e com mensagem clara se o Node for antigo. Importado primeiro pelo CLI e pelo MCP server: o IDE
// (Cursor ou Claude Code) inicia o servidor com o `node` do PATH dele, e um gerenciador de versões (mise, nvm)
// pode não estar ativo ali.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(
    `cursor-workflows: Node ${process.versions.node} é antigo demais; o @cursor/sdk exige 22.13 ou mais novo. ` +
      "Confira `node -v` no ambiente que inicia este processo (IDE, terminal ou CI).\n",
  );
  process.exit(1);
}
export {};
