import { randomUUID } from "node:crypto";
import type { SubagentState } from "./core.ts";

export const SUBAGENT_COMPLETION_TYPE = "background-subagent-result";
export type SubagentOperation = Readonly<{ operationId: string; toolCallId: string }>;
type Start = SubagentOperation & { kind: "start"; childIds: readonly number[] };
type Completion = SubagentOperation & { kind: "completion"; childId: number; deliveryId: string; status: SubagentState["status"] };

// Pi loads extensions with separate module caches. A shared symbol, not a module
// singleton, carries internal producer fields on the ACTUAL details object.
// Non-enumerable symbol properties survive native in-process delivery but are
// absent from JSON/persisted history/RPC, and cannot be supplied by user/model JSON text.
// Other installed extension code is trusted; copied/reconstructed details lose
// authority. There is no global receipt registry or retained task/report text.
const correlation = Symbol.for("mypi.subagents.native-correlation.v1");
function mark<T extends object>(details: T, receipt: Start | Completion): T {
  Object.defineProperty(details, correlation, { value: Object.freeze(receipt) });
  return details;
}
function internal(details: unknown): Start | Completion | undefined {
  if (!details || typeof details !== "object") return;
  return Object.getOwnPropertyDescriptor(details, correlation)?.value;
}
const validOperation = (receipt: SubagentOperation) =>
  typeof receipt.operationId === "string" && receipt.operationId.length > 0 && receipt.operationId.length <= 512 &&
  typeof receipt.toolCallId === "string" && receipt.toolCallId.length > 0 && receipt.toolCallId.length <= 1024;

export const createSubagentOperation = (toolCallId: string): SubagentOperation =>
  Object.freeze({ operationId: randomUUID(), toolCallId });

export function subagentStartDetails(operation: SubagentOperation, states: SubagentState[]) {
  return mark({ states }, { ...operation, kind: "start", childIds: Object.freeze(states.map((state) => state.id)) });
}

export function subagentCompletionDetails(operation: SubagentOperation, deliveryId: string, state: SubagentState) {
  return mark({ deliveryId, state }, { ...operation, kind: "completion", childId: state.id, deliveryId, status: state.status });
}

export function readSubagentStart(details: unknown): Start | undefined {
  const receipt = internal(details);
  if (receipt?.kind !== "start" || !validOperation(receipt)) return;
  const states = (details as { states?: SubagentState[] }).states;
  if (Array.isArray(states) && states.length > 0 && states.length <= 16 &&
      states.length === receipt.childIds.length && new Set(receipt.childIds).size === states.length &&
      states.every((state, i) => Number.isSafeInteger(state?.id) && state.id > 0 && state.id === receipt.childIds[i])) return receipt;
}

export function readSubagentCompletion(details: unknown): Completion | undefined {
  const receipt = internal(details);
  if (receipt?.kind !== "completion" || !validOperation(receipt)) return;
  const candidate = details as { deliveryId?: string; state?: SubagentState };
  if (candidate.deliveryId === receipt.deliveryId && receipt.deliveryId.length > 0 && receipt.deliveryId.length <= 512 &&
      candidate.state?.id === receipt.childId && candidate.state.status === receipt.status &&
      ["completed", "failed", "aborted"].includes(receipt.status)) return receipt;
}
