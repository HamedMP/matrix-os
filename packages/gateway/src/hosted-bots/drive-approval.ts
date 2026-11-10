import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { BotIntegrationError, type BotIntegrationClient } from "../bots/integration-client.js";

const MAX_REQUESTS = 4;
const MAX_ACCOUNTS = 16;
const MAX_CONTENT_BYTES = 24 * 1024;
const DEADLINE_MS = 90_000;
const AccountId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const AccountLabel = z.string().min(1).max(100).refine((label) => label === label.trim() && !/[\x00-\x1f\x7f]/.test(label));
const FileId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const Read = z.strictObject({ fileId: FileId });
const Decision = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("allow"), accountId: AccountId }),
  z.strictObject({ decision: z.literal("deny") }),
]);
const Content = z.object({
  fileId: FileId,
  name: z.string().max(1024).optional(),
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_CONTENT_BYTES),
});

type Failure = "forbidden" | "unavailable";
type Outcome = { data: z.infer<typeof Content> } | { error: Failure };

interface DriveRequest {
  id: string;
  fileId: string;
  expiresAt: number;
  status: "pending" | "reading";
  cancel: AbortController;
  settle: (outcome: Outcome) => void;
}

async function json<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? "")) return null;
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function integrationFailure(error: unknown): Failure {
  if (error instanceof BotIntegrationError && error.code !== "unavailable") return "forbidden";
  console.warn("[hosted-bots-drive] Integration unavailable", error instanceof Error ? error.name : "UnknownError");
  return "unavailable";
}

export function createHostedBotsDriveApproval(options: {
  admitted: boolean;
  ownerId: string;
  isOwner: (c: Context) => boolean;
  integration: Pick<BotIntegrationClient, "inventory" | "call">;
  timeoutMs?: number;
}) {
  const ownerRoutes = new Hono();
  const guestRoutes = new Hono();
  // The cap and per-request deadline bound waiting connections and in-memory state.
  const requests = new Map<string, DriveRequest>();
  let closed = false;
  const limit = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "too_large" }, 413) });
  for (const routes of [ownerRoutes, guestRoutes]) {
    routes.use("*", async (c, next) => {
      c.header("cache-control", "no-store");
      c.header("x-content-type-options", "nosniff");
      if (!options.admitted) return c.json({ error: "not_found" }, 404);
      if (closed) return c.json({ error: "unavailable" }, 503);
      await next();
    });
    routes.onError((error, c) => {
      if (error.name === "BodyLimitError") return c.json({ error: "too_large" }, 413);
      console.warn("[hosted-bots-drive] Request failed", error.name);
      return c.json({ error: "unavailable" }, 503);
    });
  }
  ownerRoutes.use("*", async (c, next) => {
    if (!options.isOwner(c)) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  async function accounts(signal: AbortSignal) {
    const rows = await options.integration.inventory(options.ownerId, signal);
    return rows.filter((row) => row.service === "google_drive" && AccountId.safeParse(row.connectionId).success
      && AccountLabel.safeParse(row.label).success)
      .map((row) => ({ id: row.connectionId, label: row.label }));
  }

  async function readApproved(request: DriveRequest, accountId: string) {
    const signal = request.cancel.signal;
    try {
      const matches = (await accounts(signal)).filter((account) => account.id === accountId);
      if (matches.length !== 1 || signal.aborted) return request.settle({ error: "forbidden" });
      const result = await options.integration.call(options.ownerId, {
        service: "google_drive", action: "read_file", label: matches[0]!.label, connectionId: accountId,
        params: { fileId: request.fileId }, read: true,
      }, signal);
      const content = Content.safeParse(result.data);
      request.settle(content.success && content.data.fileId === request.fileId
        ? { data: content.data } : { error: "unavailable" });
    } catch (error: unknown) {
      if (!signal.aborted) request.settle({ error: integrationFailure(error) });
    }
  }

  ownerRoutes.get("/", async (c) => {
    const search = new URL(c.req.url).search;
    if (search !== "" && search !== "?includeAccounts=1") return c.json({ error: "invalid_request" }, 400);
    const visibleAccounts = search && requests.size
      ? (await accounts(c.req.raw.signal)).slice(0, MAX_ACCOUNTS) : [];
    const visibleRequests = Array.from(requests.values(), ({ id, fileId, expiresAt, status }) => ({ id, fileId, expiresAt, status }));
    return c.json({ requests: visibleRequests, accounts: visibleAccounts });
  });

  ownerRoutes.post("/:requestId/decision", limit, async (c) => {
    const id = z.uuid().safeParse(c.req.param("requestId"));
    const decision = await json(c, Decision);
    if (!id.success || !decision || new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
    const request = requests.get(id.data);
    if (!request) return c.json({ error: "not_found" }, 404);
    if (request.status !== "pending") return c.json({ error: "conflict" }, 409);
    if (decision.decision === "allow") {
      request.status = "reading";
      void readApproved(request, decision.accountId);
    } else {
      request.settle({ error: "forbidden" });
    }
    return c.json({ ok: true }, 202);
  });

  ownerRoutes.delete("/:requestId", limit, (c) => {
    const id = z.uuid().safeParse(c.req.param("requestId"));
    if (!id.success || new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
    const request = requests.get(id.data);
    if (!request) return c.json({ error: "not_found" }, 404);
    request.settle({ error: "forbidden" });
    return c.json({ ok: true });
  });

  guestRoutes.post("/read", limit, async (c) => {
    const input = await json(c, Read);
    if (!input || new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
    if (closed || c.req.raw.signal.aborted) return c.json({ error: "forbidden" }, 403);
    if (requests.size >= MAX_REQUESTS) return c.json({ error: "limit" }, 429);

    const id = randomUUID();
    const cancel = new AbortController();
    const deadline = options.timeoutMs ?? DEADLINE_MS;
    const outcome = Promise.withResolvers<Outcome>();
    const onAbort = () => settle({ error: "forbidden" });
    const timer = setTimeout(onAbort, deadline);
    timer.unref();
    function settle(result: Outcome) {
      // Cancel and complete the waiting response once, including when an
      // in-flight provider resolves after owner revocation or socket close.
      if (!requests.delete(id)) return;
      clearTimeout(timer);
      c.req.raw.signal.removeEventListener("abort", onAbort);
      cancel.abort();
      outcome.resolve(result);
    }
    requests.set(id, { id, fileId: input.fileId, expiresAt: Date.now() + deadline, status: "pending", cancel, settle });
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

    const result = await outcome.promise;
    if ("data" in result) return c.json(result.data);
    return c.json(result, result.error === "forbidden" ? 403 : 503);
  });

  return { ownerRoutes, guestRoutes, close() {
    closed = true;
    for (const request of requests.values()) request.settle({ error: "forbidden" });
  } };
}
