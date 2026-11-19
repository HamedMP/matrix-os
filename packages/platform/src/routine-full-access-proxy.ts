import { ROUTINE_FULL_ACCESS_SCOPE_HEADER, RoutineFullAccessIdSchema } from "@matrix-os/contracts";
import { routineOwnerSession } from "./routine-action-proof.js";
import { mintRoutineFullAccessProof, routineFullAccessPath, routineFullAccessTuple } from "./routine-full-access-proof.js";
import { readRoutineProofProxyBody, type ReadRoutineProofProxyBody } from "./routine-proof-proxy-body.js";
import type { OwnerApprovalProxyInput } from "./canonical-owner-approval-proxy.js";

async function session(input: OwnerApprovalProxyInput): Promise<number | null> {
  try { return await routineOwnerSession(input); }
  catch (error: unknown) {
    console.warn("[routine-full-access] Browser session unavailable");
    return null;
  }
}

export async function authenticatedRoutineFullAccessProxyProof(input: OwnerApprovalProxyInput, readTurnBody?: ReadRoutineProofProxyBody):
  Promise<string | null | { status: 400 | 408 | 413 | 503 }> {
  const route = routineFullAccessPath(input.method, input.path), machine = input.machine;
  if (!route || !input.platformSecret || !machine?.machineId || machine.handle !== input.handle
    || machine.clerkUserId !== input.identity.userId || input.identity.source !== "auth") return null;

  const scopeId = input.request.headers.get(ROUTINE_FULL_ACCESS_SCOPE_HEADER);
  const direct = route.kind === "turn" && scopeId === null;
  if (direct && (machine.provisioningClass !== "customer" || machine.status !== "running"
    || machine.activationState !== "authorized" || machine.deletedAt !== null)) return null;
  if (route.kind === "turn" && !direct && !RoutineFullAccessIdSchema.safeParse(scopeId).success) return null;

  // Check legacy callers before reading their bodies. Direct turns are ordinary Chat requests,
  // so parse the bounded body before doing any Clerk lookup for the routine proof.
  let sessionExpiresAt = direct ? null : await session(input);
  if (!direct && !sessionExpiresAt) return null;
  const body = route.kind === "turn" && readTurnBody ? await readTurnBody()
    : await readRoutineProofProxyBody(input.request, route.kind === "turn" ? 128 * 1024 : 4000, input.timeoutMs);
  if (typeof body !== "string") return body;
  const tuple = routineFullAccessTuple({ method: input.method, path: input.path, body, scopeId,
    handle: input.handle, ownerId: input.identity.userId, runtimeSlot: machine.runtimeSlot, machineId: machine.machineId });
  if (!tuple) return null;
  if (direct) sessionExpiresAt = await session(input);
  return sessionExpiresAt ? mintRoutineFullAccessProof({ tuple, secret: input.platformSecret, sessionExpiresAt }) : null;
}
