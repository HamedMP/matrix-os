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
import { requestHasBody } from "./http-body.js";

type SymphonyRunner = ReturnType<typeof createSymphonyRunner>;

const SYMPHONY_BODY_LIMIT = 16 * 1024;
const EmptyBodySchema = z.object({}).strict();

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

async function parseOptionalJson<T>(c: Context, schema: z.ZodType<T>): Promise<
  { ok: true; value: T } | { ok: false; status: number; code: string; message: string }
> {
  let raw: unknown = {};
  if (requestHasBody(c)) {
    try {
      raw = await c.req.json();
    } catch (err: unknown) {
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
  onConfigChange?: (config: { port: number; runningPort?: number }) => void;
}) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: SYMPHONY_BODY_LIMIT });
  const runner = options.runner ?? createSymphonyRunner({ homePath: options.homePath });

  app.get("/status", async (c) => c.json(await runner.status()));
  app.get("/config", async (c) => c.json(await runner.getConfig()));

  app.post("/config", limited, async (c) => {
    const parsed = await parseOptionalJson<SymphonyConfigUpdate>(c, SymphonyConfigUpdateSchema);
    if (!parsed.ok) return c.json(errorBody(parsed.code, parsed.message), status(parsed.status));
    const config = await runner.saveConfig(parsed.value);
    const runnerStatus = await runner.status();
    options.onConfigChange?.({
      port: config.port,
      runningPort: runnerStatus.running ? runnerStatus.config.port : undefined,
    });
    return c.json(config);
  });

  app.post("/start", limited, async (c) => {
    const parsed = await parseOptionalJson<SymphonyConfigUpdate>(c, SymphonyConfigUpdateSchema);
    if (!parsed.ok) return c.json(errorBody(parsed.code, parsed.message), status(parsed.status));
    const result = await runner.start(parsed.value);
    if (result.ok) options.onConfigChange?.({ port: result.status.config.port });
    return startResponse(c, result);
  });

  app.post("/stop", limited, async (c) => {
    const parsed = await parseOptionalJson(c, EmptyBodySchema);
    if (!parsed.ok) return c.json(errorBody(parsed.code, parsed.message), status(parsed.status));
    const runnerStatus = await runner.stop();
    options.onConfigChange?.({
      port: runnerStatus.config.port,
      runningPort: runnerStatus.running ? runnerStatus.config.port : undefined,
    });
    return c.json(runnerStatus);
  });

  return app;
}
