import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OwnerScope } from "./state-ops.js";
import { createProjectMetadataService, ProjectMetadataPatchSchema, ProjectMetadataSlugSchema } from "./project-metadata.js";

type Admission = <T>(input: {
  ownerScope: OwnerScope;
  projectSlug: string;
  kind: "write" | "run";
  operation(projectId: string): Promise<T>;
}) => Promise<{ ok: true; value: T } | { ok: false; status: number; body: { error: unknown } }>;

export function registerProjectMetadataRoutes(app: Hono, options: {
  update: ReturnType<typeof createProjectMetadataService>;
  getOwnerScope(c: Context): OwnerScope;
  principalError(c: Context, error: unknown): Response;
  admit: Admission;
}) {
  app.patch("/api/projects/:slug", bodyLimit({ maxSize: 64 * 1024 }), async c => {
    let ownerScope: OwnerScope;
    try { ownerScope = options.getOwnerScope(c); }
    catch (error: unknown) { return options.principalError(c, error); }
    const slug = ProjectMetadataSlugSchema.safeParse(c.req.param("slug"));
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return c.json({ error: { code: "invalid_request", message: "Project update is invalid" } }, 400);
    }
    const patch = ProjectMetadataPatchSchema.safeParse(raw);
    if (!slug.success || !patch.success) return c.json({ error: { code: "invalid_request", message: "Project update is invalid" } }, 400);
    const admitted = await options.admit({
      ownerScope,
      projectSlug: slug.data,
      kind: "write",
      operation: projectId => options.update(slug.data, ownerScope, patch.data, projectId),
    });
    if (!admitted.ok) return c.json(admitted.body, admitted.status as ContentfulStatusCode);
    const result = admitted.value;
    if (!result.ok) return c.json({ error: result.error }, result.status as ContentfulStatusCode);
    return c.json({ project: result.project });
  });
}
