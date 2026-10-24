import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MatrixOpenAiConnectionSchema, MatrixOpenAiConnectSchema, MatrixOpenAiRefreshSchema, MatrixOpenAiDisconnectSchema } from "@matrix-os/contracts";
import { MatrixOpenAiConnectionError, type MatrixOpenAiConnectionService } from "./matrix-openai-connection.js";
import { MatrixOpenAiSourceError } from "./matrix-openai-source.js";
import type { AiProviderSnapshotReader } from "./service.js";
import { projectConnectionModelInputs } from "./connection-model-input-projection.js";

/** Mounted beneath /api/ai. Runtime owner authentication precedes reads, JSON parsing and provider calls. */
export function createMatrixOpenAiConnectionRoutes(options: {
  ownerId: string | null; service: MatrixOpenAiConnectionService | null;
  providerSnapshotReader?: AiProviderSnapshotReader;
  getPrincipal: (context: Context) => { userId: string } | null;
}) {
  if (!options.getPrincipal) throw new Error("Matrix connection route dependencies required");
  const app = new Hono();
  const path = "/matrix-connections/openai";
  // Hono subtree matching includes this exact root, without neighboring prefixes.
  app.use(`${path}/*`, async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    const principal = options.getPrincipal(context);
    if (!principal) return context.json({ error: { code: "unauthorized", message: "Authentication is required." } }, 401);
    if (options.ownerId && principal.userId !== options.ownerId) return context.json({ error: { code: "forbidden", message: "This operation is unavailable." } }, 403);
    if (!options.ownerId || !options.service || !options.providerSnapshotReader) return context.json({ error: { code: "unavailable", message: "This operation is unavailable. Refresh and try again." } }, 503);
    await next();
  });
  app.use(`${path}/*`, bodyLimit({ maxSize: 8192, onError: context => context.json({ error: { code: "body_too_large", message: "Request body is too large." } }, 413) }));
  async function handle(context: Context, action?: (service: MatrixOpenAiConnectionService, owner: string) => Promise<unknown>) {
    try {
      if (action) await action(options.service!, options.ownerId!);
      const snapshot = await options.providerSnapshotReader!.getSnapshot({ admissionScope: "managed_matrix", suppressFundedProbes: true });
      if (!snapshot.matrixOpenAiConnection) throw new MatrixOpenAiConnectionError("unavailable");
      return context.json(projectConnectionModelInputs(MatrixOpenAiConnectionSchema.parse(snapshot.matrixOpenAiConnection)));
    }
    catch (error) {
      if (error instanceof MatrixOpenAiConnectionError || error instanceof MatrixOpenAiSourceError) {
        const statuses = { forbidden: 403, rejected: 400, conflict: 409, unavailable: 503 } as const;
        return context.json({ error: { code: error.code, message: "This operation is unavailable. Refresh and try again." } }, statuses[error.code]);
      }
      console.warn("[matrix-connection] Request unavailable:", error instanceof Error ? error.name : "UnknownError");
      return context.json({ error: { code: "unavailable", message: "This operation is unavailable. Refresh and try again." } }, 503);
    }
  }
  async function json(context: Context) {
    try { return await context.req.json(); }
    catch (error) { if (error instanceof Error && error.name === "BodyLimitError") throw error; if (!(error instanceof SyntaxError)) console.warn("[matrix-connection] Invalid body:", error instanceof Error ? error.name : "UnknownError"); return undefined; }
  }
  const invalid = (context: Context) => context.json({ error: { code: "invalid_request", message: "Invalid request." } }, 400);
  app.get(path, context => handle(context));
  app.post(`${path}/connect`, async context => { const body = MatrixOpenAiConnectSchema.safeParse(await json(context));
    return body.success ? handle(context, (service, owner) => service.connect(owner, body.data)) : invalid(context); });
  app.post(`${path}/refresh`, async context => { const body = MatrixOpenAiRefreshSchema.safeParse(await json(context));
    return body.success ? handle(context, (service, owner) => service.refresh(owner, body.data)) : invalid(context); });
  app.post(`${path}/disconnect`, async context => { const body = MatrixOpenAiDisconnectSchema.safeParse(await json(context));
    return body.success ? handle(context, (service, owner) => service.disconnect(owner, body.data)) : invalid(context); });
  return app;
}
