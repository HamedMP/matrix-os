/** Getting started app routes (spec 639): progress, one-time awards, the first automatic open, and whether the desktop icon was placed. */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  GettingStartedAppAwardRequestSchema,
  type GettingStartedAppAwardableTaskId,
  type GettingStartedAppAwardResponse,
  type GettingStartedAppProgress,
} from "@matrix-os/contracts";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";

const WRITE_BODY_LIMIT = 1024;
const UNAVAILABLE = { error: "Getting started is unavailable" } as const;
const INVALID = { error: "Invalid Getting started request" } as const;

const AutoOpenRequestSchema = z.object({}).strict();

export interface GettingStartedAppRouteRepository {
  progress(ownerId: string): Promise<GettingStartedAppProgress>;
  award(ownerId: string, taskId: GettingStartedAppAwardableTaskId, silent: boolean): Promise<GettingStartedAppAwardResponse>;
  claimAutoOpen(ownerId: string): Promise<boolean>;
  desktopIconPlaced(ownerId: string): Promise<boolean>;
  markDesktopIconPlaced(ownerId: string): Promise<void>;
}

class MissingOwnerError extends Error {
  constructor() {
    super("missing owner");
    this.name = "MissingOwnerError";
  }
}

export function createGettingStartedAppRoutes(deps: {
  /** Null when the owner database is not configured. */
  repository: GettingStartedAppRouteRepository | null;
  getOwnerId(context: Context): string | null;
}): Hono {
  const app = new Hono();
  const writeBodyLimit = bodyLimit({
    maxSize: WRITE_BODY_LIMIT,
    onError: (context) => context.json({ error: "Request body too large" }, 413),
  });

  app.use("*", async (context, next) => {
    if (!deps.repository) return context.json(UNAVAILABLE, 503);
    await next();
  });

  function ownerId(context: Context): string {
    const value = deps.getOwnerId(context);
    if (!value) throw new MissingOwnerError();
    return value;
  }

  function repository(): GettingStartedAppRouteRepository {
    if (!deps.repository) throw new Error("Getting started repository is not configured");
    return deps.repository;
  }

  async function readJson(context: Context): Promise<unknown> {
    try {
      return await context.req.json();
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  function handleError(context: Context, error: unknown) {
    if (error instanceof MissingOwnerError) return context.json({ error: "Unauthorized" }, 401);
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error, UNAVAILABLE.error);
      if (mapped.log) console.error("[getting-started-app] Request principal misconfigured:", error.name);
      return context.json(mapped.body, mapped.status);
    }
    // The client gets a generic message; the server log keeps the real cause.
    console.error("[getting-started-app] Request failed:", error);
    return context.json(UNAVAILABLE, 500);
  }

  app.get("/progress", async (context) => {
    try {
      return context.json(await repository().progress(ownerId(context)));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  app.post("/awards", writeBodyLimit, async (context) => {
    try {
      const owner = ownerId(context);
      const parsed = GettingStartedAppAwardRequestSchema.safeParse(await readJson(context));
      if (!parsed.success) return context.json(INVALID, 400);
      return context.json(await repository().award(owner, parsed.data.taskId, parsed.data.silent));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  app.post("/auto-open", writeBodyLimit, async (context) => {
    try {
      const owner = ownerId(context);
      const parsed = AutoOpenRequestSchema.safeParse(await readJson(context));
      if (!parsed.success) return context.json(INVALID, 400);
      return context.json({ open: await repository().claimAutoOpen(owner) });
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  app.get("/desktop-icon", async (context) => {
    try {
      return context.json({ placed: await repository().desktopIconPlaced(ownerId(context)) });
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  app.post("/desktop-icon", writeBodyLimit, async (context) => {
    try {
      const owner = ownerId(context);
      const parsed = AutoOpenRequestSchema.safeParse(await readJson(context));
      if (!parsed.success) return context.json(INVALID, 400);
      await repository().markDesktopIconPlaced(owner);
      return context.json({ placed: true });
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  return app;
}
