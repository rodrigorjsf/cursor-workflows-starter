// How a finished execution of a run is classed. The metrics database stores the class of every run, and `wf gc` reads it to
// tell a run that failed from one that was delivered or cancelled: one definition, so they never disagree.
import type { RunStatus } from "./events.js";

const DELIVERED = new Set(["done", "delivered", "ok", "success", "succeeded"]);
/** Status que aguardam alguém (ex.: seams propostas esperando aprovação): não são entrega nem falha. */
const PENDING = new Set(["seams-proposed", "pending"]);

/** Classe do resultado: delivered (entregou), failed (o workflow decidiu que não entregou), error (exceção/teto), cancelled (alguém cancelou o run). */
export function outcomeClass(status: RunStatus, outcomeStatus?: string): string {
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "error";
  if (outcomeStatus === undefined) return "unknown";
  if (PENDING.has(outcomeStatus)) return "pending";
  return DELIVERED.has(outcomeStatus) ? "delivered" : "failed";
}
