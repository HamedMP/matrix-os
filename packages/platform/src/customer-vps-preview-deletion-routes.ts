import type { Hono, Context } from "hono";
import { z } from "zod/v4";
import type { CustomerVpsService } from "./customer-vps-types.js";
import { logCustomerVpsError } from "./customer-vps-errors.js";
const Scope = z.object({
  owner: z
    .string()
    .regex(/^user_[A-Za-z0-9]+$/)
    .max(100),
  pr: z.coerce.number().int().min(1).max(999999999),
});
export function registerPreviewDeletionRoute(
  app: Hono,
  service: CustomerVpsService,
  authorize: (c: Context) => Response | null,
) {
  app.get("/preview-cleanup", async (c) => {
    const error = authorize(c);
    if (error) return error;
    const scope = Scope.safeParse(c.req.query());
    if (!scope.success) return c.json({ error: "Invalid request" }, 400);
    try {
      return c.json(await service.previewCleanupStatus(scope.data));
    } catch (err) {
      logCustomerVpsError("preview cleanup status failed", err);
      return c.json({ error: "Preview status unavailable" }, 503);
    }
  });
}
