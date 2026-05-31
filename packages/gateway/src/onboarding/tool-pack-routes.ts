import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SelectToolPacksRequestSchema } from "./activation-contracts.js";
import { mapActivationError } from "./activation-errors.js";
import type { ToolPackService } from "./tool-packs.js";
import {
  requireRequestPrincipal,
  type RequestPrincipal,
} from "../request-principal.js";

const TOOL_PACK_BODY_LIMIT = 2048;

export interface ToolPackRouteDeps {
  service: ToolPackService;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function jsonError(c: Context, err: unknown) {
  const mapped = mapActivationError(err);
  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
}

export function createToolPackRoutes(deps: ToolPackRouteDeps): Hono {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: TOOL_PACK_BODY_LIMIT });
  const principalFor = (c: Context) => deps.getPrincipal?.(c) ?? requireRequestPrincipal(c);

  app.get("/tools", async (c) => {
    try {
      const principal = principalFor(c);
      return c.json(await deps.service.listToolPacks(principal.userId));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/tools/selection", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const body = SelectToolPacksRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.selectToolPacks(principal.userId, body.packIds));
    } catch (err) {
      return jsonError(c, err);
    }
  });

  app.post("/tools/install", limited, async (c) => {
    try {
      const principal = principalFor(c);
      const body = SelectToolPacksRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.installToolPacks(principal.userId, body.packIds), 202);
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}
