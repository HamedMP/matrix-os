import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import type { AiProviderSnapshotReader } from "./service.js";

const ProviderQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
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
      return context.json(await options.service.getSnapshot({
        refresh: query.data.refresh === "true",
      }));
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
