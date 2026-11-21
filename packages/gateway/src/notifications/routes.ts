import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod/v4";
import { NotificationPreferencesSchema, SafeClientErrorSchema, CodingAgentNotificationPreferencesUpdateSchema } from "@matrix-os/contracts";
import {
  isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal,
  type PrincipalRuntimeConfig, type RequestPrincipal,
} from "../request-principal.js";
import { logCodingAgentWarning } from "../coding-agents/diagnostics.js";
import type { CodingAgentNotificationPreferenceStore } from "../coding-agents/notification-preferences.js";
import {
  NotificationPreferencesAccessError, NotificationPreferencesConflictError,
  type NotificationPreferenceStore,
} from "./preferences-store.js";

function safeError(code: string, safeMessage: string, retryable = false) {
  return { error: SafeClientErrorSchema.parse({ code, safeMessage, retryable, ...(retryable ? { recoveryActions: ["retry"] } : {}) }) };
}
function failure(c: Context, error: unknown) {
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error);
    return c.json(mapped.body, mapped.status);
  }
  if (error instanceof NotificationPreferencesAccessError) return c.json({ error: "Forbidden" }, 403);
  if (error instanceof NotificationPreferencesConflictError) return c.json(safeError(
    "notification_preferences_conflict", "Notification preferences changed. Reload and try again.", true,
  ), 409);
  if (error instanceof HTTPException && error.status === 413) return c.json(tooLarge(), 413);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json(safeError(
    "validation_failed", "Request could not be processed. Check the inputs and try again.",
  ), 400);
  logCodingAgentWarning("notification preferences unavailable", error);
  return c.json(safeError("notification_preferences_unavailable", "Notification preferences are temporarily unavailable. Try again.", true), 503);
}
function tooLarge() {
  return safeError("payload_too_large", "Request is too large. Reduce the content and try again.");
}
interface RouteOptions {
  getPrincipal?(c: Context): RequestPrincipal;
  principalConfig?: Partial<PrincipalRuntimeConfig>;
}

export function createNotificationPreferenceRoutes(options: RouteOptions & { store: NotificationPreferenceStore }): Hono {
  const app = new Hono();
  const principalFor = (c: Context) => options.getPrincipal?.(c) ?? requireRequestPrincipal(c, options.principalConfig);
  // Resolve and authorize before buffering/parsing a write, as well as inside the store.
  app.use("/preferences", async (c, next) => {
    try { options.store.assertOwner(principalFor(c)); }
    catch (error: unknown) { return failure(c, error); }
    await next();
  });
  app.get("/preferences", async c => {
    try { return c.json({ preferences: await options.store.load(principalFor(c)) }); }
    catch (error: unknown) { return failure(c, error); }
  });
  app.put("/preferences", bodyLimit({ maxSize: 16 * 1024, onError: c => c.json(tooLarge(), 413) }), async c => {
    try {
      const document = NotificationPreferencesSchema.parse(await c.req.json());
      return c.json({ preferences: await options.store.save(principalFor(c), document) });
    } catch (error: unknown) { return failure(c, error); }
  });
  return app;
}

/** Preserve the old 4 KiB endpoint and response while sharing the owner authorization/store. */
export function createLegacyNotificationPreferenceRoutes(options: RouteOptions & { store: CodingAgentNotificationPreferenceStore }): Hono {
  const app = new Hono();
  const principalFor = (c: Context) => options.getPrincipal?.(c) ?? requireRequestPrincipal(c, options.principalConfig);
  app.use("/notification-preferences", async (c, next) => {
    try { options.store.preferences.assertOwner(principalFor(c)); }
    catch (error: unknown) { return failure(c, error); }
    await next();
  });
  app.get("/notification-preferences", async c => {
    try { return c.json({ preferences: await options.store.load(principalFor(c)) }); }
    catch (error: unknown) { return failure(c, error); }
  });
  app.put("/notification-preferences", bodyLimit({ maxSize: 4 * 1024, onError: c => c.json(tooLarge(), 413) }), async c => {
    try {
      const document = CodingAgentNotificationPreferencesUpdateSchema.parse(await c.req.json());
      return c.json({ preferences: await options.store.save(principalFor(c), document) });
    } catch (error: unknown) { return failure(c, error); }
  });
  return app;
}
