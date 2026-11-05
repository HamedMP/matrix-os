import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PreviewPairLaunchAttestationSchema } from "@matrix-os/contracts/preview-pair-launch";
import { verifyPreviewPairLaunch } from "./launch-proof.js";
import { PreviewPairAccessError } from "./readers.js";
import type { PreviewPairHttpService } from "./routes.js";

/** No Clerk/user identity is synthesized from this non-authorizing proof. */
export function createPreviewPairLaunchVerification(options: { secret?: string; service: PreviewPairHttpService; now: () => number }) {
  const routes = new Hono();
  routes.post("/launch/verify", async (c, next) => {
    const headers = new Headers(c.req.raw.headers); headers.delete("Content-Length");
    c.req.raw = new Request(c.req.raw, { headers }); await next();
  }, bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "Request body too large" }, 413) }), async c => {
    if ((c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return c.json({ error: "Invalid request" }, 415);
    const raw = PreviewPairLaunchAttestationSchema.parse(await c.req.json());
    const context = verifyPreviewPairLaunch(raw, options.secret ?? "", options.now());
    if (!context) throw new PreviewPairAccessError(404);
    if (!options.service.launchCurrent) throw new PreviewPairAccessError(503);
    if (!await options.service.launchCurrent(context)) throw new PreviewPairAccessError(404);
    return c.json({ valid: true });
  });
  return routes;
}
