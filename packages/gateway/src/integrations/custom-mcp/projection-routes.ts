import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CustomMcpProjectionStore } from "./projection-store.js";

const ApprovalSchema = z.enum(["always_ask", "allow"]);
const ProjectionSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  url: z.url().max(2_048),
  authMode: z.enum(["none", "oauth", "bearer", "api_key"]),
  enabled: z.boolean(),
  revision: z.number().int().min(1),
  tools: z.array(z.object({
    name: z.string().min(1).max(128),
    enabled: z.boolean(),
    approval: ApprovalSchema,
  }).strict()).max(100),
}).strict();

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createCustomMcpProjectionRoutes(options: {
  homePath: string;
  token: string;
  clerkUserId: string;
}): Hono {
  const app = new Hono();
  const store = new CustomMcpProjectionStore(options.homePath);

  function authorize(context: Context): Response | null {
    const authorization = context.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const clerkUserId = context.req.header("x-matrix-clerk-user-id");
    if (!safeEqual(token, options.token) || !safeEqual(clerkUserId, options.clerkUserId)) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    return null;
  }

  app.get("/:id", async (context) => {
    const rejected = authorize(context);
    if (rejected) return rejected;
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Not found" }, 404);
    const file = await store.read();
    const server = file.servers.find((entry) => entry.id === id.data);
    return server ? context.json(server) : context.json({ error: "Not found" }, 404);
  });

  app.post("/", bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    const rejected = authorize(context);
    if (rejected) return rejected;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch (parseError: unknown) {
      console.warn(
        "[custom-mcp] projection body parse failed:",
        parseError instanceof Error ? parseError.name : typeof parseError,
      );
      return context.json({ error: "Invalid request body" }, 400);
    }
    const parsed = ProjectionSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "Invalid request body" }, 400);
    await store.upsert(parsed.data);
    return context.json({ ok: true });
  });

  app.delete("/:id", bodyLimit({ maxSize: 64 * 1024 }), async (context) => {
    const rejected = authorize(context);
    if (rejected) return rejected;
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.json({ error: "Not found" }, 404);
    await store.remove(id.data);
    return context.json({ ok: true });
  });

  return app;
}
