import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import type { AiProviderSnapshotReader } from "./service.js";

const ProviderQuerySchema = z.object({
  includeNativeProfiles: z.enum(["true", "false"]).optional(),
  refresh: z.enum(["true", "false"]).optional(),
  includeFundingState: z.enum(["true", "false"]).optional(),
  includeChatFunding: z.enum(["true", "false"]).optional(),
}).strict();

export function createAiProviderRoutes(options: {
  service: AiProviderSnapshotReader;
  getPrincipal: (context: Context) => unknown;
}) {
  if (!options.service) throw new Error("AI provider service is required");
  if (!options.getPrincipal) throw new Error("AI provider principal resolver is required");

  const app = new Hono();
  app.get("/providers", async (context) => {
    options.getPrincipal(context);
    const query = ProviderQuerySchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Invalid provider status query" }, 400);
    try {
      const internalSnapshot = await options.service.getSnapshot({
        refresh: query.data.refresh === "true",
      });
      const legacyReadiness = <T extends { safeReason: string | null }>(readiness: T): T =>
        readiness.safeReason === "budget_exceeded" && query.data.includeChatFunding !== "true"
          ? { ...readiness, safeReason: "policy" }
          : readiness.safeReason === "credit_reserved" && query.data.includeFundingState !== "true"
            ? { ...readiness, safeReason: "credit_required" } : readiness;
      const snapshot = {
        ...internalSnapshot,
        accessSources: internalSnapshot.accessSources.map(legacyReadiness),
        accounts: internalSnapshot.accounts.map(legacyReadiness),
        instances: internalSnapshot.instances.map(instance => ({ ...instance, readiness: legacyReadiness(instance.readiness) })),
      };
      if (query.data.includeNativeProfiles === "true") return context.json(snapshot);
      const { nativeHarnessCatalog: _nativeHarnessCatalog, ...legacySnapshot } = snapshot;
      return context.json({ ...legacySnapshot,
        drivers: snapshot.drivers.map(({ nativeRouteObservation: _nativeRouteObservation, ...driver }) => driver),
      });
    } catch (err) {
      console.warn(
        "[ai-providers] Failed to build provider status:",
        err instanceof Error ? err.name : "UnknownError",
      );
      return context.json({ error: "AI provider status is unavailable" }, 503);
    }
  });
  return app;
}
