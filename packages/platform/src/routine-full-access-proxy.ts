import { ROUTINE_FULL_ACCESS_SCOPE_HEADER, RoutineFullAccessIdSchema } from "@matrix-os/contracts";
import { routineOwnerSession } from "./routine-action-proof.js";
import { mintRoutineFullAccessProof, routineFullAccessPath } from "./routine-full-access-proof.js";
import type { OwnerApprovalProxyInput } from "./canonical-owner-approval-proxy.js";

export async function authenticatedRoutineFullAccessProxyProof(input: OwnerApprovalProxyInput): Promise<string | null | { status: 400 | 408 | 413 | 503 }> {
  const route = routineFullAccessPath(input.method, input.path), machine = input.machine;
  if (!route || !input.platformSecret || !machine?.machineId || machine.handle !== input.handle
    || machine.clerkUserId !== input.identity.userId || input.identity.source !== "auth"
    || input.identity.runtimeSlot !== undefined && input.identity.runtimeSlot !== machine.runtimeSlot) return null;
  const scopeId = input.request.headers.get(ROUTINE_FULL_ACCESS_SCOPE_HEADER);
  if (route.kind === "turn" && !RoutineFullAccessIdSchema.safeParse(scopeId).success) return null;
  let sessionExpiresAt: number | null;
  try { sessionExpiresAt = await routineOwnerSession(input); }
  catch (error: unknown) { console.warn("[routine-full-access] Browser session unavailable"); return null; }
  if (!sessionExpiresAt) return null;
  const reader = input.request.clone().body?.getReader();
  if (!reader) return null;
  const cancel = () => {
    void reader.cancel().catch((error: unknown) => console.warn("[routine-full-access] Body cancellation unavailable", typeof error));
    void input.request.body?.cancel().catch((error: unknown) => console.warn("[routine-full-access] Body cancellation unavailable", typeof error));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("RoutineFullAccessBodyTimeout")), input.timeoutMs ?? 5000); timer.unref?.(); });
  const limit = route.kind === "turn" ? 128 * 1024 : 4000;
  const buffer = Buffer.alloc(limit); let bytes = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) { cancel(); return { status: 413 }; }
      buffer.set(next.value, bytes - next.value.byteLength);
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    return mintRoutineFullAccessProof({ method: input.method, path: input.path, body, secret: input.platformSecret, scopeId,
      handle: input.handle, ownerId: input.identity.userId, runtimeSlot: machine.runtimeSlot, machineId: machine.machineId, sessionExpiresAt });
  } catch (error: unknown) {
    cancel();
    if (error instanceof Error && error.message === "RoutineFullAccessBodyTimeout") return { status: 408 };
    console.warn("[routine-full-access] Browser proof unavailable");
    return { status: error instanceof TypeError ? 400 : 503 };
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
