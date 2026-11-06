import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { ROUTINE_FULL_ACCESS_PROOF_HEADER, RoutineFullAccessTupleSchema } from "@matrix-os/contracts";
import { verifyRoutineFullAccessProof } from "./routine-full-access-proof.js";
import { createRoutineProofVerificationGuard } from "./routine-proof-verification-guard.js";
import type { BrowserApprovalMachineLookup } from "./browser-approval-machine-lookup.js";

/** Existing transport verifies only; no nonce consumption, scope consent or grant. */
export function createRoutineFullAccessVerificationRoutes(options: { platformSecret: string;
  lookup?: Pick<BrowserApprovalMachineLookup, "resolveMachine">; bodyTimeoutMs?: number }) {
  if (options.lookup && typeof options.lookup.resolveMachine !== "function") throw new Error("Routine verification dependency unavailable");
  const app = new Hono();
  app.post("/internal/containers/:handle/routine-full-access/verify", createRoutineProofVerificationGuard(options), bodyLimit({ maxSize: 4000 }), async c => {
    try {
      const tuple = RoutineFullAccessTupleSchema.safeParse(await c.req.json());
      if (!tuple.success || tuple.data.handle !== c.req.param("handle")) return c.json({ error: "Invalid request" }, 400);
      const verified = verifyRoutineFullAccessProof(c.req.header(ROUTINE_FULL_ACCESS_PROOF_HEADER), tuple.data, options.platformSecret);
      if (!verified) return c.json({ error: "Origin unavailable" }, 403);
      const machine = await options.lookup!.resolveMachine(tuple.data.handle, tuple.data.runtimeSlot);
      if (verified.expiresAt <= Date.now() || !machine || machine.status !== "running" || machine.machineId !== tuple.data.machineId
        || machine.clerkUserId !== tuple.data.ownerId || machine.runtimeSlot !== tuple.data.runtimeSlot) return c.json({ error: "Origin unavailable" }, 403);
      return c.json({ verified }, 200, { "Cache-Control": "private, no-store" });
    } catch (error: unknown) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
      console.warn("[routine-full-access] Verification unavailable");
      return c.json({ error: "Origin unavailable" }, 503);
    }
  });
  return app;
}
