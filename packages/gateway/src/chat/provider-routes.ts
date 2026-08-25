import { CanonicalChatSafeErrorSchema } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatProviderCatalogService } from "./provider-catalog.js";

export function createChatProviderRoutes(options: {
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  getPrincipal: (context: Context) => RequestPrincipal;
}): Hono {
  const routes = new Hono();
  routes.get("/api/chat-providers", async (context) => {
    const principal = options.getPrincipal(context);
    try {
      return context.json(await options.catalog.getCatalog(principal));
    } catch {
      console.warn("[chat-providers] Provider catalog request failed");
      return context.json({
        error: CanonicalChatSafeErrorSchema.parse({
          code: "service_unavailable",
          safeMessage: "Provider catalog is temporarily unavailable.",
          retryable: true,
          recoveryActions: ["retry"],
        }),
      }, 503);
    }
  });
  return routes;
}
