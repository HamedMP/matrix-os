import { lstat } from "node:fs/promises";
import type { Hono } from "hono";
import { ProjectIdSchema } from "@matrix-os/contracts";
import { GalleryError, isFsError, pinDirectory } from "./app-gallery/pinned-directory.js";
import { ChatExecutionRootError, type ChatExecutionRootResolver } from "./chat/execution-root.js";
import { readProjectAgentContext } from "./project-agent-context.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal } from "./request-principal.js";

function sameDirectory(
  pinned: { dev: number; ino: number },
  current: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return current.isDirectory() && current.dev === pinned.dev && current.ino === pinned.ino;
}

export function registerProjectAgentContextRoute(app: Hono, options: {
  executionRoots: ChatExecutionRootResolver | null;
}): void {
  const { executionRoots } = options;
  app.get("/api/projects/:projectId/agent-context", async c => {
    c.header("Cache-Control", "no-store");
    const notFound = () => c.json({ error: "Project not found" }, 404);
    const unavailable = () => c.json({ error: "Project context unavailable" }, 503);
    try {
      const owner = { type: "personal" as const, ownerId: requireRequestPrincipal(c).userId };
      const parsed = ProjectIdSchema.safeParse(c.req.param("projectId"));
      if (!parsed.success) return c.json({ error: "Invalid project reference" }, 400);
      if (!executionRoots) return unavailable();
      const resolved = await executionRoots.resolve(owner, { kind: "project", projectId: parsed.data });
      const path = resolved.primaryWorkspaceRoot;
      const before = await lstat(path);
      const directory = await pinDirectory(path);
      try {
        const identity = await directory.identity();
        if (!sameDirectory(identity, before)) return notFound();
        const context = await readProjectAgentContext(directory);
        const current = await executionRoots.revalidate(owner, resolved);
        if (current.primaryWorkspaceRoot !== path || !sameDirectory(identity, await lstat(path))) return notFound();
        return c.json(context);
      } finally { await directory.close(); }
    } catch (error) {
      if (isRequestPrincipalError(error)) {
        const mapped = mapRequestPrincipalError(error);
        if (mapped.log) console.warn("[project-agent-context] Request principal unavailable");
        return c.json(mapped.body, mapped.status);
      }
      if (error instanceof ChatExecutionRootError && error.code !== "validation_unavailable") return notFound();
      if (["ENOENT", "ENOTDIR", "ELOOP"].some(code => isFsError(error, code))) return notFound();
      if (!(error instanceof GalleryError)) {
        console.warn("[project-agent-context] Inspection unavailable", error instanceof Error ? error.name : "unknown");
      }
      return unavailable();
    }
  });
}
