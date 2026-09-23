import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import { FileResourceRefSchema, type FileResourceRef } from "@matrix-os/contracts";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  type RequestPrincipal,
} from "./request-principal.js";
import { FilePreviewError, type FilePreviewService } from "./file-preview-service.js";

const QuerySchema = z.object({
  kind: z.enum(["home", "project", "artifact"]),
  path: z.string().min(1).max(4096).optional(),
  projectId: z.string().min(1).max(160).optional(),
  worktreeId: z.string().min(1).max(128).optional(),
  chatId: z.string().min(1).max(160).optional(),
  artifactId: z.string().min(1).max(160).optional(),
  download: z.enum(["true", "false"]).optional(),
}).strict();

export function createFilePreviewRoutes(options: {
  service: FilePreviewService;
  getPrincipal(c: Context): RequestPrincipal;
}): Hono {
  const app = new Hono();

  type ParsedRequest =
    | { ok: true; ref: FileResourceRef; download: boolean }
    | { ok: false; status: 400 | 404 };

  function parseRef(c: Context): ParsedRequest {
    const query = QuerySchema.safeParse({
      kind: c.req.query("kind"),
      path: c.req.query("path"),
      projectId: c.req.query("projectId"),
      worktreeId: c.req.query("worktreeId"),
      chatId: c.req.query("chatId"),
      artifactId: c.req.query("artifactId"),
      download: c.req.query("download"),
    });
    if (!query.success) return { ok: false, status: 400 };
    const { kind } = query.data;
    const candidate = kind === "home"
      ? { kind, path: query.data.path }
      : kind === "project"
        ? {
            kind,
            projectId: query.data.projectId,
            ...(query.data.worktreeId ? { worktreeId: query.data.worktreeId } : {}),
            path: query.data.path,
          }
        : { kind, chatId: query.data.chatId, artifactId: query.data.artifactId };
    const ref = FileResourceRefSchema.safeParse(candidate);
    return ref.success
      ? { ok: true, ref: ref.data, download: query.data.download === "true" }
      : { ok: false, status: 404 };
  }

  function errorResponse(c: Context, error: unknown): Response {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error, "File preview unavailable");
      if (mapped.log) console.error("[file-preview] request principal misconfigured", error.name);
      return c.json(mapped.body, mapped.status);
    }
    if (error instanceof FilePreviewError) {
      if (error.code === "not_found") return c.json({ error: "not_found" }, 404);
      if (error.code === "busy") return c.json({ error: "preview_busy" }, 429);
    }
    console.warn("[file-preview] request failed", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "preview_unavailable" }, 503);
  }

  app.get("/metadata", async (c) => {
    const parsed = parseRef(c);
    if (!parsed.ok) {
      return parsed.status === 404
        ? c.json({ error: "not_found" }, 404)
        : c.json({ error: "invalid_request" }, 400);
    }
    try {
      return c.json(await options.service.resolvePreview(options.getPrincipal(c), parsed.ref));
    } catch (error: unknown) {
      return errorResponse(c, error);
    }
  });

  const content = async (c: Context) => {
    const parsed = parseRef(c);
    if (!parsed.ok) {
      return parsed.status === 404
        ? c.json({ error: "not_found" }, 404)
        : c.json({ error: "invalid_request" }, 400);
    }
    try {
      return await options.service.openPreviewContent(options.getPrincipal(c), parsed.ref, {
        range: c.req.header("range"),
        ifRange: c.req.header("if-range"),
        download: parsed.download,
        head: c.req.method === "HEAD",
        signal: c.req.raw.signal,
      });
    } catch (error: unknown) {
      return errorResponse(c, error);
    }
  };
  app.get("/content", content);
  app.on("HEAD", "/content", content);
  return app;
}
