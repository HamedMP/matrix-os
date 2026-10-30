import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { PreviewPairIdSchema } from "@matrix-os/contracts/preview-pair";
import { bearerTokenMatches } from "../customer-vps-auth.js";
import { CustomerVpsError } from "../customer-vps-errors.js";
import { PreviewPairActionSchema, PreviewPairListSchema, PreviewPairReconcileSchema, PreviewPairStartSchema,
  PreviewPairPrepareRequestSchema, PreviewPairRequestStopSchema,
  type PreviewPairStartRequest, type PreviewPairActionRequest } from "./api-contracts.js";
import { verifiedPreviewPairReader, PreviewPairAccessError, type PreviewPairReader } from "./readers.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairReadinessFailure } from "./readiness.js";
import { PreviewPairProvenanceError } from "./provenance.js";

export interface PreviewPairHttpService {
  prepareRequest?(input: z.infer<typeof PreviewPairPrepareRequestSchema>): Promise<unknown>;
  stopRequest?(pairId: string, input: z.infer<typeof PreviewPairRequestStopSchema>): Promise<unknown>;
  start(input: PreviewPairStartRequest): Promise<unknown>;
  action(pairId: string, input: PreviewPairActionRequest): Promise<unknown>;
  reconcile(input: { limit: number }): Promise<unknown>;
  report(pairId: string, reader: PreviewPairReader): Promise<unknown>;
  manifest(pairId: string, reader: PreviewPairReader): Promise<unknown>;
  list(query: z.infer<typeof PreviewPairListSchema>, reader: PreviewPairReader): Promise<unknown>;
}
export interface PreviewPairRoutesDeps {
  enabled: boolean; operatorSecret?: string; service?: PreviewPairHttpService;
  authenticateReader?: (request: Request) => Promise<unknown>;
  now?: () => number;
}
export function createPreviewPairRoutes(deps: PreviewPairRoutesDeps) {
  const app = new Hono(), operator = new Hono();
  const reader = new Hono<{ Variables: { principal: PreviewPairReader } }>();
  const now = deps.now ?? Date.now;
  const prefixes = ["/vps/preview-pairs/*", "/api/preview-pairs/*"];
  for (const prefix of prefixes) app.use(prefix, async (c, next) => {
    c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache");
    if (!deps.enabled || !deps.service) return c.json({ error: "Preview pairs are unavailable" }, 503);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
    if (error instanceof PreviewPairAccessError) return c.json({ error: "Preview pair is unavailable" }, error.status);
    if (error instanceof PreviewPairReadinessFailure) return c.json({ error: "Preview pair is unavailable" }, 503);
    if (error instanceof PreviewPairConflictError || error instanceof PreviewPairProvenanceError) return c.json({ error: "Preview pair is unavailable" }, 409);
    if (error instanceof CustomerVpsError && [400, 401, 403, 404, 409, 429].includes(error.status)) {
      return c.json({ error: "Preview pair is unavailable" }, error.status as 400 | 401 | 403 | 404 | 409 | 429);
    }
    console.warn("[preview-pair] request unavailable", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Preview pair is unavailable" }, 503);
  });
  operator.use("*", async (c, next) => {
    if (!deps.operatorSecret || deps.operatorSecret.length < 32) return c.json({ error: "Preview pairs are unavailable" }, 503);
    if (!bearerTokenMatches(c.req.header("Authorization"), deps.operatorSecret)) return c.json({ error: "Unauthorized" }, 401);
    // Force Hono's streaming size check even when Content-Length is false.
    const headers = new Headers(c.req.raw.headers); headers.delete("Content-Length");
    c.req.raw = new Request(c.req.raw, { headers });
    await next();
  });
  operator.use("*", bodyLimit({ maxSize: 16 * 1_024, onError: c => c.json({ error: "Request body too large" }, 413) }));
  operator.use("*", async (c, next) => {
    if ((c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
      return c.json({ error: "Invalid request" }, 415);
    }
    await next();
  });
  operator.post("/", async c => c.json(await deps.service!.start(PreviewPairStartSchema.parse(await c.req.json())), 202));
  operator.post("/requests", async c => {
    if (!deps.service!.prepareRequest) throw new PreviewPairAccessError(503);
    return c.json(await deps.service!.prepareRequest(PreviewPairPrepareRequestSchema.parse(await c.req.json())), 202);
  });
  operator.post("/requests/:pairId/actions", async c => {
    if (!deps.service!.stopRequest) throw new PreviewPairAccessError(503);
    return c.json(await deps.service!.stopRequest(PreviewPairIdSchema.parse(c.req.param("pairId")),
      PreviewPairRequestStopSchema.parse(await c.req.json())));
  });
  operator.post("/reconcile", async c => c.json(await deps.service!.reconcile(PreviewPairReconcileSchema.parse(await c.req.json()))));
  operator.post("/:pairId/actions", async c => c.json(await deps.service!.action(
    PreviewPairIdSchema.parse(c.req.param("pairId")), PreviewPairActionSchema.parse(await c.req.json()))));
  reader.use("*", async (c, next) => {
    if (!deps.authenticateReader) return c.json({ error: "Preview pairs are unavailable" }, 503);
    c.set("principal", verifiedPreviewPairReader(await deps.authenticateReader(c.req.raw), now()));
    await next();
  });
  reader.get("/", async c => {
    const query = c.req.queries();
    if (Object.values(query).some(values => values.length !== 1)) return c.json({ error: "Invalid request" }, 400);
    const parsed = PreviewPairListSchema.parse(c.req.query());
    return c.json(await deps.service!.list(parsed, c.get("principal")));
  });
  reader.get("/:pairId/manifest", async c => c.json(await deps.service!.manifest(PreviewPairIdSchema.parse(c.req.param("pairId")), c.get("principal"))));
  reader.get("/:pairId", async c => c.json(await deps.service!.report(PreviewPairIdSchema.parse(c.req.param("pairId")), c.get("principal"))));
  operator.all("*", c => c.json({ error: "Preview pair is unavailable" }, 404));
  reader.all("*", c => c.json({ error: "Preview pair is unavailable" }, 404));
  app.route("/vps/preview-pairs", operator); app.route("/api/preview-pairs", reader);
  return app;
}
