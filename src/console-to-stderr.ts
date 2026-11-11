// stdout é dado de máquina: o JSON do CLI e o canal JSON-RPC do servidor MCP. O @cursor/sdk escreve logs INFO por
// console.log (medido em 2026-11-11: "LocalCursorRulesService load completed"), então log, info e debug vão para o
// stderr. Importe este módulo antes de qualquer outro.
import { format } from "node:util";

const toStderr = (...args: unknown[]) => {
  process.stderr.write(format(...args) + "\n");
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
