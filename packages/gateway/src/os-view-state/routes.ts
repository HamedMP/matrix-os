import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PatchOsViewStateRequestSchema, type OsViewStateResponse, type PatchOsViewStateRequest } from "@matrix-os/contracts";
import { isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
import { OsViewStateConflictError } from "./repository.js";

const OS_VIEW_STATE_BODY_LIMIT = 256 * 1024;

export interface OsViewStateRouteRepository {
  getOrCreate(ownerId: string): Promise<OsViewStateResponse>;
  patch(ownerId: string, request: PatchOsViewStateRequest): Promise<OsViewStateResponse>;
}

export function createOsViewStateRoutes(deps: {
  repository: OsViewStateRouteRepository;
  getOwnerId: (context: Context) => string;
}): Hono {
  const app = new Hono();
  const writeBodyLimit = bodyLimit({
    maxSize: OS_VIEW_STATE_BODY_LIMIT,
    onError: (context) => context.json({ error: "Request body too large" }, 413),
  });

  function ownerId(context: Context): string {
    const value = deps.getOwnerId(context);
    if (!value) throw new Error("missing owner");
    return value;
  }

  function handleError(context: Context, error: unknown) {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error, "OS-view state request failed");
      if (mapped.log) console.error("[os-view-state] Request principal misconfigured:", error.name);
      return context.json(mapped.body, mapped.status);
    }
    if (error instanceof OsViewStateConflictError) {
      return context.json({ error: "os_view_state_conflict", latestRevision: error.latestRevision }, 409);
    }
    if (error instanceof Error && error.message === "missing owner") {
      return context.json({ error: "Unauthorized" }, 401);
    }
    console.error("[os-view-state] Request failed:", error instanceof Error ? error.name : "UnknownError");
    return context.json({ error: "OS-view state request failed" }, 500);
  }

  app.get("/", async (context) => {
    try {
      return context.json(await deps.repository.getOrCreate(ownerId(context)));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  app.patch("/", writeBodyLimit, async (context) => {
    try {
      const parsed = PatchOsViewStateRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return context.json({ error: "Invalid OS-view state mutation" }, 400);
      return context.json(await deps.repository.patch(ownerId(context), parsed.data));
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return context.json({ error: "Invalid OS-view state mutation" }, 400);
      }
      return handleError(context, error);
    }
  });

  return app;
}
