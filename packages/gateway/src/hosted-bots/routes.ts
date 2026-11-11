import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { HostedBotsError } from "./contracts.js";
import type { HostedBotsRepository } from "./repository.js";

const id = z.uuid();
const createBot = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const createThread = z.object({ title: z.string().trim().min(1).max(100).optional() }).strict();
const enqueueRun = z.object({ requestId: id, mode: z.enum(["chat", "setup"]), text: z.string().trim().min(1).max(4_000) }).strict();
const connectModel = z.object({ apiKey: z.string().trim().min(16).max(256).regex(/^sk-[A-Za-z0-9_-]+$/) }).strict();
const undoChange = z.object({}).strict();

const limited = bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: "too_large" }, 413) });

export function createHostedBotsRoutes(options: {
  admitted: boolean;
  repository: HostedBotsRepository | null;
  resolveOwner: (c: Context) => string | null;
  model: { connected(): Promise<boolean>; connect(key: string): Promise<void> };
  wake: () => void;
}) {
  const app = new Hono();
  const repository = options.repository;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!options.admitted) return c.json({ error: "not_found" }, 404);
    if (!options.resolveOwner(c)) return c.json({ error: "forbidden" }, 403);
    if (!repository) return c.json({ error: "unavailable" }, 503);
    await next();
  });
  const owner = (c: Context) => options.resolveOwner(c)!;
  async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return null;
    try {
      const result = schema.safeParse(await c.req.json());
      return result.success ? result.data : null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
  }
  app.onError((error, c) => {
    if (error.name === "BodyLimitError") return c.json({ error: "too_large" }, 413);
    if (error instanceof HostedBotsError) {
      const status = error.code === "not_found" ? 404 : error.code === "limit" ? 429 : 409;
      return c.json({ error: error.code }, status);
    }
    console.warn("[hosted-bots] Request failed", { errorName: error.name });
    return c.json({ error: "unavailable" }, 503);
  });

  app.get("/", async (c) => c.json({ bots: await repository!.listBots(owner(c)) }));
  app.post("/", limited, async (c) => {
    const input = await body(c, createBot);
    if (!input) return c.json({ error: "invalid_request" }, 400);
    return c.json({ bot: await repository!.createBot(owner(c), input.name) }, 201);
  });

  app.get("/model", async (c) => c.json({ connected: await options.model.connected() }));
  app.put("/model", limited, async (c) => {
    const input = await body(c, connectModel);
    if (!input) return c.json({ error: "invalid_request" }, 400);
    await options.model.connect(input.apiKey);
    return c.json({ connected: true });
  });

  app.get("/:botId", async (c) => {
    const botId = id.safeParse(c.req.param("botId"));
    if (!botId.success) return c.json({ error: "invalid_request" }, 400);
    return c.json(await repository!.readBot(owner(c), botId.data));
  });

  app.post("/:botId/threads", limited, async (c) => {
    const botId = id.safeParse(c.req.param("botId"));
    const input = await body(c, createThread);
    if (!botId.success || !input) return c.json({ error: "invalid_request" }, 400);
    return c.json({ thread: await repository!.createThread(owner(c), botId.data, input.title ?? "New conversation") }, 201);
  });

  const threadParams = z.object({ botId: id, threadId: id });
  app.get("/:botId/threads/:threadId", async (c) => {
    const path = threadParams.safeParse(c.req.param());
    if (!path.success) return c.json({ error: "invalid_request" }, 400);
    return c.json(await repository!.readThread(owner(c), path.data.botId, path.data.threadId));
  });

  app.post("/:botId/threads/:threadId/runs", limited, async (c) => {
    const path = threadParams.safeParse(c.req.param());
    const input = await body(c, enqueueRun);
    if (!path.success || !input) return c.json({ error: "invalid_request" }, 400);
    if (!await options.model.connected()) throw new HostedBotsError("model_required");
    const run = await repository!.enqueue(owner(c), path.data.botId, path.data.threadId, input);
    options.wake();
    return c.json({ run }, 202);
  });

  app.post("/:botId/profile-changes/:changeId/undo", limited, async (c) => {
    const path = z.object({ botId: id, changeId: id }).safeParse(c.req.param());
    if (!path.success || !await body(c, undoChange)) return c.json({ error: "invalid_request" }, 400);
    return c.json({ bot: await repository!.undo(owner(c), path.data.botId, path.data.changeId) });
  });
  return app;
}
