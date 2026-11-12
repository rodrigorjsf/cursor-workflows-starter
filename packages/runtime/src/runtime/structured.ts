// Saída estruturada sobre o Cursor SDK.
//
// O SDK (1.3.1) NÃO tem response_format/JSON Schema nas runs: RunResult.result é string, e
// SDKCustomTool.outputSchema é "puramente descritivo". O contorno é uma custom tool local
// `submit_result` cujo inputSchema é o schema pedido. O execute() valida com Ajv no nosso processo:
// inválido → devolve isError para o modelo corrigir; válido → captura o objeto.
// Custom tools são apenas locais (não funcionam em cloud agents) e não pedem aprovação.

import { Ajv } from "ajv";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import type { JsonSchema } from "./workflow.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export const SUBMIT_TOOL = "submit_result";

export interface Capture {
  value: unknown;
  submitted: boolean;
  lastError?: string;
}

export function submitResultTool(schema: JsonSchema, capture: Capture): SDKCustomTool {
  const validate = ajv.compile(schema);
  return {
    description:
      "Entrega o resultado final desta etapa. Chame exatamente uma vez, no fim, com um objeto que satisfaça o inputSchema.",
    inputSchema: schema as Record<string, SDKJsonValue>,
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: (args) => {
      if (!validate(args)) {
        capture.lastError = ajv.errorsText(validate.errors);
        return {
          content: [{ type: "text", text: `Resultado inválido: ${capture.lastError}. Corrija e chame ${SUBMIT_TOOL} de novo.` }],
          isError: true,
        };
      }
      capture.value = args;
      capture.submitted = true;
      return "Resultado registrado. Encerre a resposta.";
    },
  };
}

export function schemaInstruction(): string {
  return (
    `\n\n---\nAo terminar, chame a tool \`${SUBMIT_TOOL}\` com o resultado estruturado. ` +
    `Não responda o resultado em texto: só a chamada da tool conta.`
  );
}

export function repromptMessage(capture: Capture): string {
  return capture.lastError
    ? `A última chamada de ${SUBMIT_TOOL} foi rejeitada: ${capture.lastError}. Chame ${SUBMIT_TOOL} novamente com um objeto válido.`
    : `Você não chamou ${SUBMIT_TOOL}. Chame agora com o resultado desta etapa.`;
}
