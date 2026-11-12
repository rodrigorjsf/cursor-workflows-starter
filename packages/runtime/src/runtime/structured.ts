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
      "Delivers this step's final result. Call it exactly once, at the end, with an object that satisfies the inputSchema.",
    inputSchema: schema as Record<string, SDKJsonValue>,
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: (args) => {
      if (!validate(args)) {
        capture.lastError = ajv.errorsText(validate.errors);
        return {
          content: [{ type: "text", text: `Invalid result: ${capture.lastError}. Fix it and call ${SUBMIT_TOOL} again.` }],
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
    `\n\n---\nWhen you finish, call the \`${SUBMIT_TOOL}\` tool with the structured result. ` +
    `Do not answer the result as text: only the tool call counts.`
  );
}

export function repromptMessage(capture: Capture): string {
  return capture.lastError
    ? `The last ${SUBMIT_TOOL} call was rejected: ${capture.lastError}. Call ${SUBMIT_TOOL} again with a valid object.`
    : `You did not call ${SUBMIT_TOOL}. Call it now with this step's result.`;
}
