import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  MemoryImportRequestSchema,
  MemorySourcePatchSchema,
  MemorySearchRequestSchema,
  MemoryCompareRequestSchema,
  MemoryContextRequestSchema,
  MemoryLibraryRequestSchema,
} from "@matrix-os/contracts";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  MissingRequestPrincipalError,
} from "../request-principal.js";
import { MemoryWorkspaceService } from "./service.js";
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryLimitError,
} from "./repository.js";
const idSchema = z.uuid();
const jobActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("retry") }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
]);
export function createMemoryWorkspaceRoutes(deps: {
  service: MemoryWorkspaceService;
  getOwnerId: (context: Context) => string;
}): Hono {
  const app = new Hono();
  const limit = bodyLimit({
    maxSize: 5000000,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });
  const owner = (c: Context) => {
    const id = deps.getOwnerId(c);
    if (!id) throw new MissingRequestPrincipalError();
    return id;
  };
  const id = (c: Context) => idSchema.parse(c.req.param("id"));
  function error(c: Context, err: unknown) {
    if (isRequestPrincipalError(err)) {
      const mapped = mapRequestPrincipalError(err, "Memory request failed");
      if (mapped.log)
        console.error("[memory-workspace] Authorization unavailable", err.name);
      return c.json(mapped.body, mapped.status);
    }
    if (err instanceof Error && err.name === "BodyLimitError")
      return c.json({ error: "Request body too large" }, 413);
    if (err instanceof z.ZodError || err instanceof SyntaxError)
      return c.json({ error: "Invalid memory request" }, 400);
    if (err instanceof MemoryNotFoundError)
      return c.json({ error: "Source unavailable" }, 404);
    if (err instanceof MemoryConflictError)
      return c.json(
        { error: "Source changed. Reload before trying again." },
        409,
      );
    if (err instanceof MemoryLimitError)
      return c.json({ error: "Memory workspace limit reached" }, 413);
    console.error(
      "[memory-workspace] Request failed",
      err instanceof Error ? err.name : "UnknownError",
    );
    return c.json({ error: "Memory workspace unavailable" }, 503);
  }
  app.get("/", async (c) => {
    try {
      return c.json(
        await deps.service.snapshot(
          owner(c),
          MemoryLibraryRequestSchema.parse(c.req.query()),
        ),
      );
    } catch (err) {
      return error(c, err);
    }
  });
  app.get("/sources/:id", async (c) => {
    try {
      return c.json({ source: await deps.service.getSource(owner(c), id(c)) });
    } catch (err) {
      return error(c, err);
    }
  });
  app.post("/sources", limit, async (c) => {
    try {
      const actor = owner(c);
      const input = MemoryImportRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.importSources(actor, input), 201);
    } catch (err) {
      return error(c, err);
    }
  });
  app.patch("/sources/:id", limit, async (c) => {
    try {
      const actor = owner(c);
      const sourceId = id(c);
      const input = MemorySourcePatchSchema.parse(await c.req.json());
      return c.json({
        source: await deps.service.patchSource(actor, sourceId, input),
      });
    } catch (err) {
      return error(c, err);
    }
  });
  app.delete("/sources/:id", limit, async (c) => {
    try {
      await c.req.arrayBuffer();
      return c.json({
        deleted: await deps.service.deleteSource(owner(c), id(c)),
      });
    } catch (err) {
      return error(c, err);
    }
  });
  app.post("/search", limit, async (c) => {
    try {
      const actor = owner(c);
      const input = MemorySearchRequestSchema.parse(await c.req.json());
      return c.json(
        await deps.service.search(
          actor,
          input.query,
          input.engine,
          input.limit,
        ),
      );
    } catch (err) {
      return error(c, err);
    }
  });
  app.post("/compare", limit, async (c) => {
    try {
      const actor = owner(c);
      const input = MemoryCompareRequestSchema.parse(await c.req.json());
      return c.json(
        await deps.service.compare(actor, input.query, input.limit),
      );
    } catch (err) {
      return error(c, err);
    }
  });
  app.post("/context", limit, async (c) => {
    try {
      const actor = owner(c);
      const input = MemoryContextRequestSchema.parse(await c.req.json());
      return c.json(await deps.service.context(actor, input.sourceIds));
    } catch (err) {
      return error(c, err);
    }
  });
  app.post("/jobs/:id/action", limit, async (c) => {
    try {
      const actor = owner(c);
      const jobId = id(c);
      const action = jobActionSchema.parse(await c.req.json());
      if (!(await deps.service.jobAction(actor, jobId, action.type)))
        return c.json({ error: "Activity cannot be changed right now" }, 409);
      return c.json({ updated: true });
    } catch (err) {
      return error(c, err);
    }
  });
  return app;
}
