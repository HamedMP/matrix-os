import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";

// Mirrors the shell reporter contract without importing the gateway's Node file logger.
const reportSchema = z.object({
  errorId: z.string().regex(/^mx-[A-Za-z0-9._:-]{1,128}$/).max(160),
  source: z.string().max(80).optional(),
  name: z.string().max(120).optional(),
  message: z.string().max(1_000).optional(),
  stack: z.string().max(4_000).optional(),
  digest: z.string().max(160).optional(),
  path: z.string().max(512).optional(),
  userAgent: z.string().max(512).optional(),
  buildSha: z.string().max(128).optional(),
}).strict();

/** Auth middleware must run before registering this diagnostic endpoint. */
export function registerClientErrorRoute(app: Hono<{ Variables: { ownerId: string } }>) {
  app.post("/api/client-errors", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }), async (c) => {
    const input = reportSchema.safeParse(await c.req.json());
    if (!input.success) return c.json({ error: "Invalid error report" }, 400);
    const { userAgent: _userAgent, path, ...report } = input.data;
    // Exception text/stack are intentional diagnostic payloads, as in the native
    // gateway. Keep them in authenticated operator logs; never echo to clients.
    console.error("[workspace-client-error]", {
      ...report, ownerId: c.get("ownerId"), path: path?.split(/[?#]/, 1)[0],
    });
    return c.json({ ok: true });
  });
}
