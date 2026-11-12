// Falha cedo e com mensagem clara se o Node for antigo. Importado primeiro pelo CLI e pelo MCP server: o IDE
// (Cursor ou Claude Code) inicia o servidor com o `node` do PATH dele, e um gerenciador de versões (mise, nvm)
// pode não estar ativo ali.
//
// `wf doctor` num Node antigo ainda entrega o relatório (só com a verificação do Node, em texto ou em `--json`): é o caso
// que o comando existe para pegar, e nada mais do kit carrega nesse Node.
import { fail, formatReport, nodeHint, reportOf } from "./doctor-report.js";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  if (process.argv[2] === "doctor") {
    const node = fail("node", `v${process.versions.node} at ${process.execPath} (the node running this wf); @cursor/sdk needs Node 22.13 or newer`, nodeHint("22.13"));
    const report = reportOf([node]);
    process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  } else {
    process.stderr.write(
      `cursor-workflows: Node ${process.versions.node} is too old; @cursor/sdk needs 22.13 or newer. ` +
        "Check `node -v` in the environment that starts this process (IDE, terminal or CI).\n",
    );
  }
  process.exit(1);
}
export {};
