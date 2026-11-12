import { existsSync, readFileSync, statSync } from "node:fs";
import {
  lstat,
  mkdir as mkdirAsync,
  realpath,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PROJECT_SKILL_FILE_MAX_BYTES, ProjectAgentConfigFileSchema, ProjectIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  isDeniedFileApiPath,
  resolveExistingFileApiPath,
  resolveWithinHome,
  resolveWritableFileApiPath,
} from "../path-security.js";
import { OwnerPersonalityError } from "../bots/owner-personality.js";
import { writeOwnerSoulAtomic } from "../bots/owner-personality-write.js";
import { listDirectory } from "../files-tree.js";
import { getMissingFileFallback } from "../file-fallbacks.js";
import { fileStat, fileMkdir, fileTouch, fileRename, fileCopy, fileDuplicate } from "../file-ops.js";
import { createFileBlobRoutes } from "../file-blob-routes.js";
import { createFilePreviewRoutes } from "../file-preview-routes.js";
import type { FilePreviewService } from "../file-preview-service.js";
import type { RequestPrincipal } from "../request-principal.js";
import { fileSearch } from "../file-search.js";
import { fileDelete, trashList, trashRestore, trashEmpty } from "../trash.js";
import { listProjects } from "../projects.js";
import {
  ProjectFenceError,
} from "../collaboration/project-fence.js";
import type { LegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";
import { OwnerFileMutationBusyError, withOwnerFileMutation } from "../owner-file-mutations.js";
import { ChatExecutionRootError, type ChatExecutionRootResolver } from "../chat/execution-root.js";
import { withProjectLock } from "../state-ops.js";
import { isFsError, pinDirectory } from "../app-gallery/pinned-directory.js";
import { createProjectAgentConfigFile } from "../project-agent-context.js";

const ProjectConfigTouchSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  content: z.string().max(PROJECT_SKILL_FILE_MAX_BYTES).optional(),
  projectId: ProjectIdSchema,
  projectFile: ProjectAgentConfigFileSchema,
}).refine(({ content = "", projectFile }) => projectFile.endsWith("/SKILL.md")
  ? Buffer.byteLength(content, "utf8") <= PROJECT_SKILL_FILE_MAX_BYTES
  : content.length <= 8192, { path: ["content"] });

export interface FileRouteDeps {
  homePath: string;
  getOwnerId?: (c: Context) => string;
  getPrincipal?: (c: Context) => RequestPrincipal;
  filePreviewService?: FilePreviewService;
  projectPathAdmission?: LegacyProjectPathAdmission;
  projectExecutionRoots?: ChatExecutionRootResolver | null;
}

export function registerFileRoutes(app: Hono, deps: FileRouteDeps): void {
  const { homePath } = deps;
  const fileBodyLimit = bodyLimit({ maxSize: 10 * 1024 * 1024 });

  // Hold the owner/home boundary before path resolution, admission, blob preflight or writes.
  // Project admission remains inside this lock. Reads and unrelated routes never acquire it.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const ownerFiles = path === "/api/files" || path.startsWith("/api/files/")
      || path === "/files" || path.startsWith("/files/");
    if (!ownerFiles || !["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return next();
    try { await withOwnerFileMutation(homePath, next); }
    catch (error) {
      if (!(error instanceof OwnerFileMutationBusyError)) throw error;
      return c.json({ error: "File service unavailable" }, 503);
    }
  });

  if (deps.filePreviewService && deps.getPrincipal) {
    app.route("/api/file-previews", createFilePreviewRoutes({
      service: deps.filePreviewService,
      getPrincipal: deps.getPrincipal,
    }));
  }

  async function withProjectFileAdmission(
    c: Context,
    paths: readonly string[],
    operation: () => Promise<Response>,
    storedPaths = false,
  ): Promise<Response> {
    if (!deps.projectPathAdmission) return operation();
    if (!deps.getOwnerId) {
      return c.json({ error: "File service unavailable" }, 503);
    }
    try {
      const ownerId = deps.getOwnerId(c);
      const admit = storedPaths
        ? deps.projectPathAdmission.withStoredPaths.bind(deps.projectPathAdmission)
        : deps.projectPathAdmission.withPaths.bind(deps.projectPathAdmission);
      return await admit({
        ownerType: "personal",
        ownerId,
        paths,
        kind: "write",
      }, operation);
    } catch (err: unknown) {
      if (err instanceof ProjectFenceError) {
        if (["fenced", "scope_required", "conflict", "not_found"].includes(err.code)) {
          return c.json({ error: "Use the shared project route" }, 409);
        }
        return c.json({ error: "File service unavailable" }, 503);
      }
      console.error("[file-routes] Project admission failed:", err instanceof Error ? err.name : "UnknownError");
      return c.json({ error: "File service unavailable" }, 503);
    }
  }

  async function touchProjectConfig(c: Context, body: z.infer<typeof ProjectConfigTouchSchema>): Promise<Response> {
    const roots = deps.projectExecutionRoots;
    if (!roots || !deps.getPrincipal) return c.json({ error: "File service unavailable" }, 503);
    const notFound = () => c.json({ error: "Project file not found" }, 404);
    try {
      const owner = { type: "personal" as const, ownerId: deps.getPrincipal(c).userId };
      const root = await roots.resolve(owner, { kind: "project", projectId: body.projectId });
      const projectSlug = root.projectSlug;
      if (!projectSlug) return notFound();
      const workspacePath = relative(await realpath(homePath), root.primaryWorkspaceRoot);
      if (!workspacePath || isAbsolute(workspacePath) || workspacePath === ".." || workspacePath.startsWith("../")
        || body.path !== `${workspacePath}/${body.projectFile}`) return notFound();
      return await withProjectLock(projectSlug, async () => {
        if (!resolveWritableFileApiPath(homePath, body.path)) return notFound();
        const directory = await pinDirectory(root.primaryWorkspaceRoot);
        try {
          const identity = await directory.identity();
          const current = await roots.revalidate(owner, root);
          if (current.primaryWorkspaceRoot !== root.primaryWorkspaceRoot) return notFound();
          const checked = await lstat(current.primaryWorkspaceRoot);
          if (!checked.isDirectory() || checked.dev !== identity.dev || checked.ino !== identity.ino) return notFound();
          await createProjectAgentConfigFile(directory, body.projectFile, body.content ?? "");
          return c.json({ ok: true, path: body.path });
        } finally {
          await directory.close();
        }
      });
    } catch (error: unknown) {
      if (error instanceof ChatExecutionRootError && error.code !== "validation_unavailable") return notFound();
      if (["ENOENT", "ENOTDIR", "ELOOP"].some(code => isFsError(error, code))) return notFound();
      if (isFsError(error, "EEXIST")) return c.json({ error: "File already exists" }, 409);
      console.warn("[project-config] File creation unavailable:", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "File service unavailable" }, 503);
    }
  }

  app.get("/api/files/tree", async (c) => {
    const pathParam = c.req.query("path") ?? "";
    const result = await listDirectory(homePath, pathParam);
    if (!result) {
      return c.json({ error: "Invalid path" }, 400);
    }
    return c.json(result);
  });

  app.get("/api/files/list", async (c) => {
    const pathParam = c.req.query("path") ?? "";
    const result = await listDirectory(homePath, pathParam);
    if (!result) {
      return c.json({ error: "Invalid path" }, 400);
    }
    return c.json({ path: pathParam, entries: result });
  });

  app.get("/api/files/stat", async (c) => {
    const pathParam = c.req.query("path");
    if (!pathParam) return c.json({ error: "path required" }, 400);
    const result = await fileStat(homePath, pathParam);
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  });

  app.get("/api/files/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "q required" }, 400);
    if (q.length > 500) return c.json({ error: "q too long" }, 400);
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit) {
      limit = parseInt(rawLimit, 10);
      if (isNaN(limit) || limit < 1 || limit > 500) return c.json({ error: "limit must be 1-500" }, 400);
    }
    const result = await fileSearch(homePath, {
      q,
      path: c.req.query("path"),
      content: c.req.query("content") === "true",
      limit,
    });
    return c.json(result);
  });
  app.route("/api/files", createFileBlobRoutes({ homePath, withProjectFileAdmission }));

  app.post("/api/files/mkdir", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    return withProjectFileAdmission(c, [body.path], async () => {
      const result = await fileMkdir(homePath, body.path);
      return c.json(result, result.ok ? 200 : 400);
    });
  });

  app.post("/api/files/touch", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string; content?: string; projectId?: unknown; projectFile?: unknown }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    if ("projectId" in body || "projectFile" in body) {
      const scoped = ProjectConfigTouchSchema.safeParse(body);
      if (!scoped.success) return c.json({ error: "Invalid project file" }, 400);
      return withProjectFileAdmission(c, [scoped.data.path], () => touchProjectConfig(c, scoped.data));
    }
    return withProjectFileAdmission(c, [body.path], async () => {
      const result = await fileTouch(homePath, body.path, body.content);
      return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
    });
  });

  app.post("/api/files/duplicate", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    return withProjectFileAdmission(c, [body.path], async () => {
      const result = await fileDuplicate(homePath, body.path);
      return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
    });
  });

  app.post("/api/files/rename", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    return withProjectFileAdmission(c, [body.from, body.to], async () => {
      const result = await fileRename(homePath, body.from, body.to);
      return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
    });
  });

  app.post("/api/files/copy", fileBodyLimit, async (c) => {
    const body = await parseJson<{ from: string; to: string }>(c);
    if (!body?.from || !body?.to) return c.json({ error: "from and to required" }, 400);
    return withProjectFileAdmission(c, [body.from, body.to], async () => {
      const result = await fileCopy(homePath, body.from, body.to);
      return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
    });
  });

  app.post("/api/files/delete", fileBodyLimit, async (c) => {
    const body = await parseJson<{ path: string }>(c);
    if (!body?.path) return c.json({ error: "path required" }, 400);
    return withProjectFileAdmission(c, [body.path], async () => {
      const result = await fileDelete(homePath, body.path);
      return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
    });
  });

  app.get("/api/files/trash", async (c) => {
    const result = await trashList(homePath);
    return c.json(result);
  });

  app.post("/api/files/trash/restore", fileBodyLimit, async (c) => {
    const body = await parseJson<{ trashPath: string }>(c);
    if (!body?.trashPath) return c.json({ error: "trashPath required" }, 400);
    const entry = (await trashList(homePath)).entries.find((candidate) => candidate.trashPath === body.trashPath);
    return withProjectFileAdmission(c, entry ? [entry.originalPath] : [], async () => {
      const result = await trashRestore(homePath, body.trashPath);
      return c.json(result, { status: toStatusCode(result.ok ? 200 : (result.status ?? 400)) });
    });
  });

  app.post("/api/files/trash/empty", fileBodyLimit, async (c) => {
    const entries = await trashList(homePath);
    return withProjectFileAdmission(c, entries.entries.map((entry) => entry.originalPath), async () => {
      const result = await trashEmpty(homePath);
      return c.json(result);
    }, true);
  });

  app.get("/api/projects", async (c) => {
    const rootParam = (c.req.query("root") ?? "projects").trim();
    const result = await listProjects(homePath, rootParam);
    if (!result.ok) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ root: result.root, projects: result.projects });
  });

  app.on("HEAD", "/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveServedFilePath(homePath, filePath);
    if (!fullPath) return c.text("Forbidden", 403);
    if (!existsSync(fullPath)) {
      const fallback = getMissingFileFallback(filePath);
      if (fallback) return c.body(null, 200, { "content-type": fallback.contentType });
      return c.text("Not found", 404);
    }
    if (statSync(fullPath).isDirectory()) return c.text("Is a directory", 400);
    return c.body(null, 200);
  });

  app.get("/files/*", (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveServedFilePath(homePath, filePath);

    if (!fullPath) {
      return c.text("Forbidden", 403);
    }

    if (!existsSync(fullPath)) {
      const fallback = getMissingFileFallback(filePath);
      if (fallback) return c.body(fallback.body, 200, { "content-type": fallback.contentType });
      return c.text("Not found", 404);
    }

    if (statSync(fullPath).isDirectory()) {
      return c.text("Is a directory", 400);
    }

    const ext = filePath.split(".").pop() ?? "";

    const textMimeTypes: Record<string, string> = {
      html: "text/html",
      json: "application/json",
      js: "application/javascript",
      css: "text/css",
      md: "text/markdown",
      txt: "text/plain",
    };

    const imageMimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    };

    if (imageMimeTypes[ext]) {
      const stat = statSync(fullPath);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      if (c.req.header("if-none-match") === etag) {
        return c.body(null, 304);
      }
      const buffer = readFileSync(fullPath);
      return c.body(buffer, 200, {
        "Content-Type": imageMimeTypes[ext],
        "Cache-Control": "public, max-age=86400, immutable",
        "CDN-Cache-Control": "public, max-age=86400",
        "ETag": etag,
      });
    }

    const content = readFileSync(fullPath, "utf-8");
    return c.body(content, 200, {
      "Content-Type": textMimeTypes[ext] ?? "text/plain",
    });
  });

  app.put("/files/*", fileBodyLimit, async (c) => {
    const filePath = c.req.path.replace("/files/", "");
    const fullPath = resolveWritableFileApiPath(homePath, filePath);
    if (!fullPath) return c.text("Invalid path", 403);
    return withProjectFileAdmission(c, [filePath], async () => {
      const content = await c.req.text();
      if (fullPath === resolveWithinHome(homePath, "system/soul.md")) {
        try { await writeOwnerSoulAtomic(homePath, content); }
        catch (error: unknown) {
          if (error instanceof OwnerPersonalityError && error.code === "too_large") {
            return c.json({ error: "Personality exceeds the 16 KiB UTF-8 limit" }, 413);
          }
          if (error instanceof OwnerPersonalityError && error.code === "invalid_text") {
            return c.json({ error: "Personality contains unsupported control characters" }, 400);
          }
          console.warn("[files] SOUL save failed:", error instanceof Error ? error.name : "UnknownError");
          return c.json({ error: "Unable to save personality" }, 500);
        }
      } else {
        const dir = dirname(fullPath);
        await mkdirAsync(dir, { recursive: true });
        await writeFileAsync(fullPath, content, "utf-8");
      }
      return c.json({ ok: true });
    });
  });
}

async function parseJson<T>(c: Parameters<MiddlewareHandler>[0]): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return null;
    }
    console.error("[gateway] Unexpected request JSON parse failure:", err);
    throw err;
  }
}

function resolveServedFilePath(homePath: string, filePath: string): string | null {
  const lexicalPath = resolveWithinHome(homePath, filePath);
  if (!lexicalPath || isDeniedFileApiPath(homePath, filePath)) {
    return null;
  }

  if (existsSync(lexicalPath)) {
    return resolveExistingFileApiPath(homePath, filePath);
  }

  if (!filePath.endsWith("/manifest.json")) {
    return lexicalPath;
  }

  const dirPath = dirname(lexicalPath);
  const fallbackCandidates = [join(dirPath, "module.json"), join(dirPath, "matrix.json")];
  for (const candidate of fallbackCandidates) {
    if (existsSync(candidate)) {
      const relativeCandidate = relative(homePath, candidate);
      return resolveExistingFileApiPath(homePath, relativeCandidate);
    }
  }

  return lexicalPath;
}

function toStatusCode(status: number): ContentfulStatusCode {
  return status as ContentfulStatusCode;
}
