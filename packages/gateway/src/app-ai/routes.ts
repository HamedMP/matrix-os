import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { APP_AI_TIMEOUT_MS, AppAiRequestSchema, AppAiResultSchema, type AppAiRequest, type AppAiResult } from "@matrix-os/contracts";

interface Options {
  authorize: (context: Context, app: string) => Promise<boolean>;
  generate: (request: AppAiRequest, signal: AbortSignal) => Promise<AppAiResult>;
}

/** Mounted behind gateway auth; authorize additionally enforces owner and app grant. */
export function createAppAiRoutes(options: Options): Hono {
  const routes = new Hono();
  let inFlight = 0;
  let windowStart = 0;
  let requests = 0;
  routes.post("/", bodyLimit({ maxSize: 65_536 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
      if (!(error instanceof SyntaxError)) console.warn("[app-ai] body read failed", error);
      return c.json({ error: "Invalid app AI request" }, 400);
    }
    const parsed = AppAiRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid app AI request" }, 400);
    try {
      if (!await options.authorize(c, parsed.data.app)) return c.json({ error: "App AI access denied" }, 403);
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
      if (inFlight >= 2 || requests >= 10) return c.json({ error: "App AI is busy" }, 429);
      requests++;
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(APP_AI_TIMEOUT_MS)]);
      signal.throwIfAborted();
      inFlight++;
      let onAbort: (() => void) | undefined;
      // Keep the slot until the underlying operation ends, even if a driver
      // ignores cancellation. A timed-out driver cannot create unbounded work.
      const pending = Promise.resolve().then(() => options.generate(parsed.data, signal))
        .finally(() => { inFlight--; });
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("App AI request cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        return c.json(AppAiResultSchema.parse(await Promise.race([pending, cancelled])));
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      console.warn("[app-ai] generation failed:", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "App AI is unavailable" }, 503);
    }
  });
  return routes;
}
