import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import {
  createSymphonyRunner,
  SymphonyConfigUpdateSchema,
  type SymphonyConfigUpdate,
  type SymphonyStartResult,
} from "./symphony-runner.js";

type SymphonyRunner = ReturnType<typeof createSymphonyRunner>;

const SYMPHONY_BODY_LIMIT = 16 * 1024;

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function requestHasBody(c: Context): boolean {
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    return !Number.isFinite(parsed) || parsed > 0;
  }
  if (c.req.header("transfer-encoding")) return true;
  return c.req.raw.body !== null;
}

async function parseOptionalJson<T>(c: Context, schema: z.ZodType<T>): Promise<
  { ok: true; value: T } | { ok: false; status: number; code: string; message: string }
> {
  let raw: unknown = {};
  if (requestHasBody(c)) {
    try {
      raw = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return { ok: false, status: 413, code: "payload_too_large", message: "Request body is too large" };
      }
      if (err instanceof SyntaxError) {
        return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON" };
      }
      console.error("[symphony-routes] Failed to parse JSON:", err);
      return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON" };
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "invalid_request", message: "Request body is invalid" };
  }
  return { ok: true, value: parsed.data };
}

function startResponse(c: Context, result: SymphonyStartResult) {
  if (!result.ok) {
    return c.json(errorBody(result.code, result.message), status(result.status));
  }
  return c.json(result.status);
}

export function createSymphonyRoutes(options: {
  homePath: string;
  runner?: SymphonyRunner;
}) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: SYMPHONY_BODY_LIMIT });
  const runner = options.runner ?? createSymphonyRunner({ homePath: options.homePath });

  app.get("/status", async (c) => c.json(await runner.status()));
  app.get("/config", async (c) => c.json(await runner.getConfig()));

  app.post("/config", limited, async (c) => {
    const parsed = await parseOptionalJson<SymphonyConfigUpdate>(c, SymphonyConfigUpdateSchema);
    if (!parsed.ok) return c.json(errorBody(parsed.code, parsed.message), status(parsed.status));
    return c.json(await runner.saveConfig(parsed.value));
  });

  app.post("/start", limited, async (c) => {
    const parsed = await parseOptionalJson<SymphonyConfigUpdate>(c, SymphonyConfigUpdateSchema);
    if (!parsed.ok) return c.json(errorBody(parsed.code, parsed.message), status(parsed.status));
    return startResponse(c, await runner.start(parsed.value));
  });

  app.post("/stop", limited, async (c) => c.json(await runner.stop()));

  return app;
}
