import { CanonicalChatSafeErrorSchema } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import type { RequestPrincipal } from "../request-principal.js";
import {
  ProviderCatalogUnavailableError,
  type ChatProviderCatalogService,
} from "./provider-catalog.js";

export function createChatProviderRoutes(options: {
  catalog: Pick<ChatProviderCatalogService, "getCatalog" | "refresh">;
  getPrincipal: (context: Context) => RequestPrincipal;
}): Hono {
  const routes = new Hono();
  routes.get("/api/chat-providers", async (context) => {
    const principal = options.getPrincipal(context);
    try {
      const query = z.object({
        refresh: z.enum(["true", "false"]).optional(),
        includeConnectionLabels: z.enum(["true", "false"]).optional(),
      }).strict().safeParse({
        refresh: context.req.query("refresh"),
        includeConnectionLabels: context.req.query("includeConnectionLabels"),
      });
      if (!query.success) return context.json({ error: "Invalid request" }, 400);
      const catalog = query.data.refresh === "true"
        ? await options.catalog.refresh(principal)
        : await options.catalog.getCatalog(principal);
      // Older clients validate instances strictly. Presentation additions must be
      // negotiated on the wire, without modifying the authoritative admission catalog.
      return context.json(query.data.includeConnectionLabels === "true" ? catalog : {
        ...catalog,
        instances: catalog.instances.map(({ connectionLabel: _connectionLabel, ...legacy }) => legacy),
      });
    } catch (error: unknown) {
      const retryable = error instanceof ProviderCatalogUnavailableError && error.retryable;
      console.warn(
        "[chat-providers] Provider catalog request failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      return context.json({
        error: CanonicalChatSafeErrorSchema.parse({
          code: "service_unavailable",
          safeMessage: "Provider catalog is temporarily unavailable.",
          retryable,
          ...(retryable ? { recoveryActions: ["retry"] } : {}),
        }),
      }, 503);
    }
  });
  return routes;
}
