// The check of a workflow's args against its `meta.argsSchema`, in one place for every surface that starts a run: the engine
// (`runWorkflow` refuses a run whose args do not fit, before it writes anything) and a tool beside the runtime (the dashboard's
// Start action refuses before it starts a job), so both turn the same args away with the same sentence. It imports no engine,
// so a process that only checks args (the dashboard) does not load the Cursor SDK the engine pulls in.
import { Ajv } from "ajv";
import type { JsonSchema } from "./workflow.js";

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Why `args` do not fit `schema`, as one sentence that starts with `invalid args:` and names each field that is wrong
 * (`data/issue must be integer`, `data must have required property 'issue'`); undefined when they fit, or when there is no
 * schema. A field the schema does not declare is named too, which Ajv's own message leaves out.
 */
export function argsError(schema: JsonSchema | undefined, args: unknown): string | undefined {
  if (!schema) return undefined;
  const validate = ajv.compile(schema);
  if (validate(args)) return undefined;
  const errors = (validate.errors ?? []).map((error) =>
    error.keyword === "additionalProperties" ? { ...error, message: `${error.message}: ${String(error.params.additionalProperty)}` } : error,
  );
  return `invalid args: ${ajv.errorsText(errors)}`;
}
