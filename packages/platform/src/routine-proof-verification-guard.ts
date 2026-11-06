import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "./platform-token.js";
import type { BrowserApprovalMachineLookup } from "./browser-approval-machine-lookup.js";

/** Authenticate before collecting a bounded body for the two routine proof purposes. */
export function createRoutineProofVerificationGuard(options: { platformSecret: string;
  lookup?: Pick<BrowserApprovalMachineLookup, "resolveMachine">; bodyTimeoutMs?: number }): MiddlewareHandler {
  let active = 0;
  return async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const handle = c.req.param("handle") ?? "";
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle) || new URL(c.req.url).search) return c.json({ error: "Invalid request" }, 400);
    if (!options.platformSecret || !options.lookup) return c.json({ error: "Unavailable" }, 503);
    if (!timingSafeTokenEquals(c.req.header("authorization"), `Bearer ${buildPlatformVerificationToken(handle, options.platformSecret)}`)) return c.json({ error: "Unauthorized" }, 401);
    if (active >= 8) return c.json({ error: "Unavailable" }, 503);
    active++;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { void reader?.cancel().catch((error: unknown) => console.warn("[routine-proof] Verification body cancellation unavailable", typeof error)); };
    try {
      reader = c.req.raw.body?.getReader();
      if (reader) {
        let finished = false, bytes = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setTimeout(() => {
              if (finished) return;
              finished = true; cancel();
              controller.error(new HTTPException(408, { res: Response.json({ error: "Request unavailable" }, { status: 408, headers: { "Cache-Control": "private, no-store" } }) }));
            }, options.bodyTimeoutMs ?? 5000);
            timer.unref?.();
          },
          async pull(controller) {
            try {
              const value = await reader!.read();
              if (finished) return;
              if (value.done) { finished = true; clearTimeout(timer); controller.close(); }
              else if ((bytes += value.value.byteLength) > 4000) {
                finished = true; clearTimeout(timer); cancel();
                controller.error(new HTTPException(413, { res: Response.json({ error: "Invalid request" }, { status: 413, headers: { "Cache-Control": "private, no-store" } }) }));
              } else controller.enqueue(value.value);
            } catch (error: unknown) { if (!finished) { finished = true; clearTimeout(timer); controller.error(error); } }
          },
          cancel() { finished = true; clearTimeout(timer); cancel(); },
        });
        c.req.raw = new Request(c.req.raw, { body: stream, duplex: "half" } as RequestInit);
      }
      await next();
    } finally { clearTimeout(timer); cancel(); active--; }
  };
}
