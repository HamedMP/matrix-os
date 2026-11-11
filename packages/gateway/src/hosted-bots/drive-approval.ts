import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { BotIntegrationError, type BotIntegrationClient } from "../bots/integration-client.js";
import { validateActionParams } from "../integrations/parameter-validation.js";
import { getService } from "../integrations/registry.js";
import { validateHostedBotsGithubReadParams, type createHostedBotsGithubRead } from "./github-developer-read.js";

const MAX_REQUESTS = 4;
const MAX_ACCOUNTS = 16;
const MAX_CONTENT_BYTES = 24 * 1024;
const DEADLINE_MS = 90_000;
const AccountId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const AccountLabel = z.string().min(1).max(100).refine((label) => label === label.trim() && !/[\x00-\x1f\x7f]/.test(label));
const FileId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const Read = z.strictObject({ fileId: FileId });
const IntegrationId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const IntegrationRead = z.strictObject({
  service: IntegrationId,
  action: IntegrationId,
  params: z.custom<Record<string, unknown>>(value =>
    value !== null && typeof value === "object" && !Array.isArray(value) && safeJson(value)),
});
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
type Outcome = { data: unknown } | { error: Failure };
type RequestedRead = { legacy: true; service: "google_drive"; action: "read_file"; params: z.infer<typeof Read> }
  | ({ legacy: false } & z.infer<typeof IntegrationRead>);

interface ReadRequest {
  id: string;
  input: RequestedRead;
  expiresAt: number;
  status: "pending" | "reading";
  cancel: AbortController;
  settle: (outcome: Outcome) => void;
}

// The body is JSON at the wire. Bound nesting before provider schema checks
// and reject prototype keys even in nested component properties.
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => safeJson(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).every(([key, item]) => key.length <= 128
    && key !== "__proto__" && key !== "prototype" && key !== "constructor" && safeJson(item, depth + 1));
}

function isGithubReadAction(action: string): action is "get_pr" | "list_prs" {
  return action === "get_pr" || action === "list_prs";
}

function supportedRegistryRead(input: Pick<RequestedRead, "service" | "action">) {
  const service = getService(input.service);
  if (service?.id !== input.service || !Object.hasOwn(service.actions, input.action)) return;
  if (input.service !== "github" && (service.connectorKind !== "pipedream" || !service.pipedreamApp)) return;
  const action = service.actions[input.action];
  if (action?.risk === "read") return action;
}

function approvalResponse(input: RequestedRead, value: unknown): Outcome {
  if (input.legacy) {
    const content = Content.safeParse(value);
    return content.success && content.data.fileId === input.params.fileId
      ? { data: content.data } : { error: "unavailable" };
  }
  // Apply the response budget to the complete guest envelope.
  const envelope = { data: value };
  if (value === undefined || Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_CONTENT_BYTES) {
    return { error: "unavailable" };
  }
  return { data: envelope };
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
  github?: ReturnType<typeof createHostedBotsGithubRead>;
  integration?: Pick<BotIntegrationClient, "inventory" | "describe" | "call">;
  timeoutMs?: number;
}) {
  const ownerRoutes = new Hono();
  const integrationOwnerRoutes = new Hono();
  const guestRoutes = new Hono();
  // The cap and per-request deadline bound waiting connections and in-memory state.
  const requests = new Map<string, ReadRequest>();
  let closed = false;
  const bodyBound = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: "too_large" }, 413) });
  const limit = bodyBound(1024);
  for (const routes of [ownerRoutes, integrationOwnerRoutes, guestRoutes]) {
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
  async function accounts(signal: AbortSignal, services: ReadonlySet<string>) {
    const [github, rows] = await Promise.all([
      services.has("github") ? options.github?.account(signal) : undefined,
      options.integration && [...services].some(service => service !== "github")
        ? options.integration.inventory(options.ownerId, signal) : [],
    ]);
    const connected = rows.filter(row => row.service !== "github" && services.has(row.service))
      .map(row => ({ id: row.connectionId, service: row.service, label: row.label }));
    if (github) connected.unshift(github);
    return connected.filter(account => AccountId.safeParse(account.id).success
      && AccountLabel.safeParse(account.label).success);
  }

  async function readApproved(request: ReadRequest, accountId: string) {
    const signal = request.cancel.signal;
    const { input } = request;
    try {
      const matches = (await accounts(signal, new Set([input.service]))).filter((account) => account.id === accountId);
      if (matches.length !== 1 || signal.aborted) return request.settle({ error: "forbidden" });
      if (input.service === "github") {
        if (!options.github || !isGithubReadAction(input.action)) return request.settle({ error: "forbidden" });
        const data = await options.github.read(input.action, input.params, accountId, signal);
        return request.settle(approvalResponse(input, data));
      }
      const integration = options.integration;
      if (!integration) return request.settle({ error: "unavailable" });
      if (!input.legacy) {
        const actions = await integration.describe(options.ownerId, { service: input.service, readOnly: true }, signal);
        if (signal.aborted || !supportedRegistryRead(input)
          || !actions.some(action => action.id === input.action && action.risk === "read")) {
          return request.settle({ error: "forbidden" });
        }
      }
      const result = await integration.call(options.ownerId, {
        service: input.service, action: input.action, params: input.params,
        label: matches[0]!.label, connectionId: accountId, read: true,
      }, signal);
      request.settle(approvalResponse(input, result.data));
    } catch (error: unknown) {
      if (!signal.aborted) request.settle({ error: integrationFailure(error) });
    }
  }

  function configureOwnerRoutes(routes: Hono, legacyOnly: boolean) {
    const visible = (request: ReadRequest) => !legacyOnly || request.input.legacy;
    routes.use("*", async (c, next) => {
      if (!options.isOwner(c)) return c.json({ error: "forbidden" }, 403);
      await next();
    });

    routes.get("/", async (c) => {
      const search = new URL(c.req.url).search;
      if (search !== "" && search !== "?includeAccounts=1") return c.json({ error: "invalid_request" }, 400);
      const initial = Array.from(requests.values()).filter(visible);
      const services = new Set(initial.map(({ input }) => input.service));
      const visibleAccounts = search && services.size
        ? (await accounts(c.req.raw.signal, services)).slice(0, MAX_ACCOUNTS) : [];
      const visibleRequests = Array.from(requests.values()).filter(visible).map(({ id, input, expiresAt, status }) => {
        const { service, action, params } = input;
        return legacyOnly && input.legacy
          ? { id, fileId: input.params.fileId, expiresAt, status }
          : { id, service, action, params, expiresAt, status };
      });
      return c.json({ requests: visibleRequests, accounts: legacyOnly
        ? visibleAccounts.map(({ id, label }) => ({ id, label })) : visibleAccounts });
    });

    routes.post("/:requestId/decision", limit, async (c) => {
      const id = z.uuid().safeParse(c.req.param("requestId"));
      const decision = await json(c, Decision);
      if (!id.success || !decision || new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
      const request = requests.get(id.data);
      if (!request || !visible(request)) return c.json({ error: "not_found" }, 404);
      if (request.status !== "pending") return c.json({ error: "conflict" }, 409);
      if (decision.decision === "allow") {
        request.status = "reading";
        void readApproved(request, decision.accountId);
      } else {
        request.settle({ error: "forbidden" });
      }
      return c.json({ ok: true }, 202);
    });

    routes.delete("/:requestId", limit, (c) => {
      const id = z.uuid().safeParse(c.req.param("requestId"));
      if (!id.success || new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
      const request = requests.get(id.data);
      if (!request || !visible(request)) return c.json({ error: "not_found" }, 404);
      request.settle({ error: "forbidden" });
      return c.json({ ok: true });
    });
  }

  configureOwnerRoutes(ownerRoutes, true);
  configureOwnerRoutes(integrationOwnerRoutes, false);

  async function waitForApproval(c: Context, input: RequestedRead) {
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
    requests.set(id, { id, input, expiresAt: Date.now() + deadline, status: "pending", cancel, settle });
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

    const result = await outcome.promise;
    if ("data" in result) return c.json(result.data);
    return c.json(result, result.error === "forbidden" ? 403 : 503);
  }

  guestRoutes.post("/read", limit, async (c) => {
    const params = await json(c, Read);
    if (!params || new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
    if (!options.integration) return c.json({ error: "unavailable" }, 503);
    return waitForApproval(c, { legacy: true, service: "google_drive", action: "read_file", params });
  });

  guestRoutes.post("/integration/read", bodyBound(4096), async (c) => {
    const input = await json(c, IntegrationRead);
    if (!input || new URL(c.req.url).search) return c.json({ error: "invalid_request" }, 400);
    const action = supportedRegistryRead(input);
    if (!action) return c.json({ error: "forbidden" }, 403);
    if (Object.keys(input.params).some(key => !Object.hasOwn(action.params, key))
      || !validateActionParams(action, input.params).valid) {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (input.service === "github") {
      if (!isGithubReadAction(input.action)) return c.json({ error: "forbidden" }, 403);
      if (!validateHostedBotsGithubReadParams(input.action, input.params)) return c.json({ error: "invalid_request" }, 400);
      if (!options.github) return c.json({ error: "unavailable" }, 503);
    } else if (!options.integration) {
      return c.json({ error: "unavailable" }, 503);
    }
    return waitForApproval(c, { ...input, legacy: false });
  });

  return { ownerRoutes, integrationOwnerRoutes, guestRoutes, close() {
    closed = true;
    for (const request of requests.values()) request.settle({ error: "forbidden" });
  } };
}
