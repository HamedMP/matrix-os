import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { RoutineActionTupleSchema, ROUTINE_ACTION_PROOF_HEADER } from "@matrix-os/contracts";
import { verifyRoutineActionProof } from "./routine-action-proof.js";
import { createRoutineProofVerificationGuard } from "./routine-proof-verification-guard.js";
import type { BrowserApprovalMachineLookup } from "./browser-approval-machine-lookup.js";
/** Transport can verify an exact existing proof only. It cannot mint consent. */
export function createRoutineActionVerificationRoutes(options: { platformSecret: string; lookup?: Pick<BrowserApprovalMachineLookup, "resolveMachine"> }) {
  if (options.lookup && typeof options.lookup.resolveMachine !== "function") throw new Error("Routine verification dependency unavailable");
  const app = new Hono();
  app.post("/internal/containers/:handle/routine-actions/verify", createRoutineProofVerificationGuard(options), bodyLimit({ maxSize: 4000 }), async c => {
    const handle = c.req.param("handle");
    try {
      const tuple = RoutineActionTupleSchema.safeParse(await c.req.json());
      if (!tuple.success || tuple.data.handle !== handle) return c.json({ error: "Invalid request" }, 400);
      const verified = verifyRoutineActionProof(c.req.header(ROUTINE_ACTION_PROOF_HEADER), tuple.data, options.platformSecret);
      if (!verified) return c.json({ error: "Approval unavailable" }, 403);
      const machine = await options.lookup!.resolveMachine(handle, tuple.data.runtimeSlot);
      if (verified.expiresAt <= Date.now() || !machine || machine.status !== "running" || machine.machineId !== tuple.data.machineId
        || machine.clerkUserId !== tuple.data.ownerId || machine.runtimeSlot !== tuple.data.runtimeSlot) return c.json({ error: "Approval unavailable" }, 403);
      return c.json({ verified }, 200, { "Cache-Control": "private, no-store" });
    } catch (error: unknown) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
      console.warn("[routine-action] Verification unavailable", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Approval unavailable" }, 503);
    }
  });
  return app;
}
