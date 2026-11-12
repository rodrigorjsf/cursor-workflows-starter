// Saída estruturada sobre o Cursor SDK.
//
// O SDK (1.3.1) NÃO tem response_format/JSON Schema nas runs: RunResult.result é string, e
// SDKCustomTool.outputSchema é "puramente descritivo". O contorno é uma custom tool local
// `submit_result` cujo inputSchema é o schema pedido. O execute() valida com Ajv no nosso processo:
// inválido → devolve isError para o modelo corrigir; válido → captura o objeto.
// Custom tools são apenas locais (não funcionam em cloud agents) e não pedem aprovação. Um cloud agent entrega o resultado
// de outro jeito: o último bloco de código JSON da resposta final, validado aqui com o mesmo Ajv (`resultFromJsonBlock`).

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

/** The prompt's request for a cloud step: a cloud agent has no custom tool, so the result comes as a fenced JSON block at the end of its answer. */
export function jsonBlockInstruction(schema: JsonSchema): string {
  return (
    `\n\n---\nWhen you finish, end your final message with exactly one fenced code block labelled \`json\` that holds ` +
    `the structured result: a JSON object that satisfies this JSON Schema. Nothing may follow the block.\n\nJSON Schema:\n${JSON.stringify(schema, null, 2)}`
  );
}

/** The follow-up that asks a cloud agent to deliver the result again, with the reason the last answer was refused. */
export function jsonBlockReprompt(error: string): string {
  return `Your last message did not end with a valid result: ${error}. Reply again; end with exactly one fenced \`json\` code block that holds the result object, and nothing after it.`;
}

/** The body of the last complete fenced code block of `text` that is labelled `json` or not labelled at all. */
function lastJsonBlock(text: string): string | undefined {
  let last: string | undefined;
  let open: { ticks: number; json: boolean; body: string[] } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!open) {
      const opener = /^ {0,3}(`{3,})\s*([\w-]*)\s*$/.exec(line);
      if (opener) open = { ticks: opener[1]!.length, json: opener[2]!.toLowerCase() === "json" || opener[2] === "", body: [] };
      continue;
    }
    const closer = /^ {0,3}(`{3,})\s*$/.exec(line);
    if (closer && closer[1]!.length >= open.ticks) {
      if (open.json) last = open.body.join("\n");
      open = undefined;
    } else {
      open.body.push(line);
    }
  }
  return last;
}

/** What a cloud agent's final message holds: the result object the schema accepts, or why it holds none. */
export function resultFromJsonBlock(text: string, schema: JsonSchema): { ok: true; value: unknown } | { ok: false; error: string } {
  const block = lastJsonBlock(text);
  if (block === undefined) return { ok: false, error: "there is no fenced json code block" };
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (err) {
    return { ok: false, error: `the json code block does not parse (${err instanceof Error ? err.message : String(err)})` };
  }
  const validate = ajv.compile(schema);
  if (!validate(value)) return { ok: false, error: ajv.errorsText(validate.errors) };
  return { ok: true, value };
}
