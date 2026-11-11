// Review em três eixos separados (code-review: Standards e Spec; mais Segurança). Os relatórios nunca se misturam
// nem são reordenados: o código só decide o que bloqueia a entrega.
import type { JsonSchema } from "../../src/runtime/workflow.js";

export type Axis = "standards" | "spec" | "security";
export const AXES: Axis[] = ["standards", "spec", "security"];

export interface StandardsFinding { file: string; rule: string; kind: "hard" | "judgement"; note: string }
export interface SpecFinding { kind: "missing" | "scope-creep" | "wrong"; quote: string; note: string; behavior?: string; seam?: string }
export interface SecurityFinding { file: string; severity: "blocking" | "note"; issue: string }
export interface AxisReport<F> { findings: F[]; worst: string }
export interface ReviewReports {
  standards?: AxisReport<StandardsFinding>;
  spec?: AxisReport<SpecFinding>;
  security?: AxisReport<SecurityFinding>;
}

const str = { type: "string" };
export const AXIS_SCHEMAS: Record<Axis, JsonSchema> = {
  standards: {
    type: "object",
    required: ["findings", "worst"],
    properties: {
      findings: { type: "array", items: { type: "object", required: ["file", "rule", "kind", "note"], properties: { file: str, rule: str, kind: { enum: ["hard", "judgement"] }, note: str } } },
      worst: str,
    },
  },
  spec: {
    type: "object",
    required: ["findings", "worst"],
    properties: {
      findings: {
        type: "array",
        items: { type: "object", required: ["kind", "quote", "note"], properties: { kind: { enum: ["missing", "scope-creep", "wrong"] }, quote: str, note: str, behavior: str, seam: str } },
      },
      worst: str,
    },
  },
  security: {
    type: "object",
    required: ["findings", "worst"],
    properties: {
      findings: { type: "array", items: { type: "object", required: ["file", "severity", "issue"], properties: { file: str, severity: { enum: ["blocking", "note"] }, issue: str } } },
      worst: str,
    },
  },
};

/** O que bloqueia a entrega: padrão documentado violado, requisito faltando ou errado, falha de segurança explorável. */
export function blockingOf(r: ReviewReports) {
  return {
    standards: (r.standards?.findings ?? []).filter((f) => f.kind === "hard"),
    missing: (r.spec?.findings ?? []).filter((f) => f.kind === "missing"),
    wrong: (r.spec?.findings ?? []).filter((f) => f.kind === "wrong"),
    security: (r.security?.findings ?? []).filter((f) => f.severity === "blocking"),
  };
}

/** Eixos com achado bloqueante: só eles são revistos depois da rodada de correção. */
export function blockingAxes(r: ReviewReports): Axis[] {
  const b = blockingOf(r);
  const axes: Axis[] = [];
  if (b.standards.length) axes.push("standards");
  if (b.missing.length || b.wrong.length) axes.push("spec");
  if (b.security.length) axes.push("security");
  return axes;
}
