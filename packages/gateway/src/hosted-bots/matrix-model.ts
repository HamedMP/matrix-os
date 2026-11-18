import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { AppAiInputSchema, type AppAiRouteSelection, type ManagedWorkersAiModelId } from "@matrix-os/contracts";
import { routeSelection, sameAppAiRoute } from "../app-ai/connected-routes.js";
import type { createRuntimeAppAiService, HostedBotsApiCompletion, HostedBotsAppAiCatalog } from "../app-ai/runtime.js";
import { bindHostedBotsDriveSocket } from "./drive-approval-runtime.js";

export const MATRIX_BOTS_MODEL_ID = "@cf/zai-org/glm-5.3-flash" satisfies ManagedWorkersAiModelId;
export const MATRIX_BOTS_TURN_HEADER = "x-matrix-hosted-bots-model-turn";
const SOCKET = "/run/matrix-openmausbot-drive/model.sock";
const TOKEN_LIFETIME_MS = 45_000;
const MAX_TURNS = 24;
const MAX_TEXT = 4000;
const MAX_SEND_BYTES = 32_000;
const MAX_REDEEM_BYTES = 80_000;
const STATUS_TTL_MS = 3_000;
const MAX_PICKER_MODELS = 128;
const MAX_PROMPT = AppAiInputSchema.shape.prompt.maxLength ?? 32_000;
const id = z.string().regex(/^[\w-]{1,128}$/u);
const sendId = z.string().regex(/^[\w-]{16,80}$/u);
const turnIdentity = z.strictObject({ botId: id, threadId: id, sendId });
type Identity = z.infer<typeof turnIdentity>;
const directSend = z.strictObject({ threadId: id, sendId, text: z.string().trim().min(1).max(MAX_TEXT) });
const redeemTurn = turnIdentity.extend({
  modelId: z.union([z.literal(MATRIX_BOTS_MODEL_ID), z.string().regex(/^matrix-route-[a-f0-9]{64}$/)]),
  history: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(1000),
  })).max(12),
});
const legacyGlmRoute = {
  harnessId: "matrix_ai", accountId: null, accessSourceId: "matrix_cloudflare", modelId: MATRIX_BOTS_MODEL_ID,
} as const;

type OwnerSendTicket = (identity: Identity, text: string) => string | undefined;
export type HostedBotsModelProvider = ReturnType<typeof createRuntimeAppAiService>["hostedBots"];
export type HostedBotsManagedCompletion = (input: Parameters<HostedBotsApiCompletion>[0] & { identity: Identity }) => ReturnType<HostedBotsApiCompletion>;
type PickerModel = { id: string; label: string; tools: boolean };
type PickerCatalog = { available: boolean; default: string; models: PickerModel[] };
type PickerProjection = { public: PickerCatalog; routes: ReadonlyMap<string, AppAiRouteSelection> };
const emptyCatalog: PickerProjection = { public: { available: false, default: "", models: [] }, routes: new Map() };

function modelKey(route: AppAiRouteSelection) {
  if (sameAppAiRoute(route, legacyGlmRoute)) return MATRIX_BOTS_MODEL_ID;
  // Opaque, stable picker selections carry no account identifier. The caller
  // resolves them against the exact server-side route, never client metadata.
  return "matrix-route-" + createHash("sha256")
    .update(JSON.stringify([route.harnessId, route.accountId, route.accessSourceId, route.modelId])).digest("hex");
}

function projectPicker(catalog: HostedBotsAppAiCatalog, hasManagedTools: boolean): PickerProjection {
  const routes = new Map<string, AppAiRouteSelection>();
  const models: PickerModel[] = [];
  const published = catalog.routes.filter(route => route.availability === "available");
  const ordered = [
    ...published.filter(route => route.harnessId === "matrix_ai"),
    ...published.filter(route => route.harnessId !== "matrix_ai"),
  ];
  // Keep the authorized Matrix default in the bounded projection if the owner
  // has configured more choices than the pinned picker can carry.
  const preferred = catalog.defaultRoute;
  if (preferred) {
    const index = ordered.findIndex(route => sameAppAiRoute(route, preferred));
    if (index >= MAX_PICKER_MODELS) {
      const route = ordered.splice(index, 1)[0]!;
      ordered.splice(MAX_PICKER_MODELS - 1, 0, route);
    }
  }
  for (const route of ordered) {
    if (models.length >= MAX_PICKER_MODELS) break;
    const key = modelKey(route);
    if (routes.has(key)) continue;
    const tools = hasManagedTools && route.supportsManagedTools;
    const qualifier = route.harnessId === "matrix_ai" ? "" : " · " + route.displayName;
    models.push({ id: key, label: `${route.modelLabel.slice(0, 120)}${qualifier}${tools ? "" : " · Text only"}`, tools });
    routes.set(key, routeSelection(route));
  }
  const preferredId = preferred ? modelKey(preferred) : "";
  const defaultId = routes.has(preferredId) ? preferredId
    : routes.has(MATRIX_BOTS_MODEL_ID) ? MATRIX_BOTS_MODEL_ID : models[0]?.id ?? "";
  return { public: { available: models.length > 0, default: defaultId, models }, routes };
}

function turnPrompt(text: string, history: z.infer<typeof redeemTurn>["history"]) {
  // Preserve the authorized latest message even when JSON escapes repeat
  // within older lines. Keep the newest context that fits App AI's bound.
  for (let omitted = 0; omitted <= history.length; omitted++) {
    const prompt = JSON.stringify({ previousConversation: history.slice(omitted), currentUserMessage: text });
    if (prompt.length <= MAX_PROMPT) return prompt;
  }
  throw new Error("Matrix model prompt too large");
}

/** Called only by the already-authorized Matrix owner proxy. Ordinary proxy input never sets this header. */
export function issueHostedBotsMatrixTurn(
  issue: OwnerSendTicket, path: string, method: string, body: Uint8Array | undefined, contentType: string | undefined,
): string | undefined {
  const match = /^\/api\/bots\/([\w-]{1,128})\/messages$/u.exec(path);
  if (method !== "POST" || !match?.[1] || !body || body.byteLength > MAX_SEND_BYTES
    || !/^application\/json(?:;|$)/i.test(contentType ?? "")) return undefined;
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(body)); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const send = directSend.safeParse(data);
  if (!send.success) return undefined;
  return issue({ botId: match[1], threadId: send.data.threadId, sendId: send.data.sendId }, send.data.text);
}

type Options = {
  providers: HostedBotsModelProvider;
  generateManaged?: HostedBotsManagedCompletion;
};

export function createHostedBotsMatrixModel(options: Options) {
  const tickets = new Map<string, { identity: Identity; text: string; expiresAt: number }>();
  const lifecycle = new AbortController();
  const app = new Hono();
  let status: { at: number; catalog: PickerProjection } | undefined;
  let statusRead: Promise<PickerProjection> | undefined;
  function expire(now = Date.now()) {
    for (const [token, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(token);
  }
  const expires = setInterval(expire, 5_000);
  expires.unref();
  function warn(error: unknown) {
    console.warn("[hosted-bots] Matrix model unavailable", error instanceof Error ? error.name : "UnknownError");
  }
  function readPicker() {
    if (lifecycle.signal.aborted) return Promise.resolve(emptyCatalog);
    if (status && Date.now() - status.at < STATUS_TTL_MS) return Promise.resolve(status.catalog);
    statusRead ??= options.providers.discover(AbortSignal.any([lifecycle.signal, AbortSignal.timeout(12_000)]))
      .then(value => projectPicker(value, Boolean(options.generateManaged)))
      .catch((error: unknown) => { warn(error); return emptyCatalog; })
      .then(catalog => {
        status = { catalog, at: Date.now() };
        return catalog;
      }).finally(() => { statusRead = undefined; });
    return statusRead;
  }
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });
  app.get("/status", async (c) => c.json((await readPicker()).public));
  app.post("/turn", bodyLimit({
    maxSize: MAX_REDEEM_BYTES, onError: (c) => c.json({ error: "too_large" }, 413),
  }), async (c) => {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token || !tickets.has(token)) return c.json({ error: "forbidden" }, 403);
    const body = redeemTurn.safeParse(await c.req.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    }));
    if (!body.success) return c.json({ error: "invalid_turn" }, 400);
    const ticket = tickets.get(token);
    if (!ticket || ticket.expiresAt <= Date.now() || lifecycle.signal.aborted
      || ticket.identity.botId !== body.data.botId || ticket.identity.threadId !== body.data.threadId
      || ticket.identity.sendId !== body.data.sendId) return c.json({ error: "forbidden" }, 403);
    // No await between verifying and consuming the ticket. A retry cannot spend it twice.
    tickets.delete(token);
    try {
      // Resolve the picker ID without substituting a default. Its exact route
      // is freshly authorized by App AI, including for persisted legacy GLM.
      const key = body.data.modelId;
      const route = key === MATRIX_BOTS_MODEL_ID ? legacyGlmRoute
        : status?.catalog.routes.get(key) ?? (await readPicker()).routes.get(key);
      if (!route) return c.json({ error: "unavailable" }, 503);
      const prompt = turnPrompt(ticket.text, body.data.history);
      const generateManaged = options.generateManaged;
      const result = await options.providers.generate({
        route, prompt, signal: AbortSignal.any([lifecycle.signal, c.req.raw.signal]),
        ...(generateManaged ? { generateManaged: input => generateManaged({ ...input, identity: ticket.identity }) } : {}),
      });
      return c.json(result);
    } catch (error) {
      warn(error);
      return c.json({ error: "unavailable" }, 503);
    }
  });
  return {
    routes: app,
    issue: ((identity, text) => {
      if (lifecycle.signal.aborted) return undefined;
      const now = Date.now();
      expire(now);
      if (tickets.size >= MAX_TURNS) return undefined;
      const token = randomBytes(32).toString("hex");
      tickets.set(token, { identity, text, expiresAt: now + TOKEN_LIFETIME_MS });
      return token;
    }) satisfies OwnerSendTicket,
    close() { lifecycle.abort(); clearInterval(expires); tickets.clear(); },
  };
}

export async function initializeHostedBotsMatrixModel(options: Options & { admitted: boolean; socketPath?: string }) {
  if (!options.admitted) {
    return { issue: undefined, close: async () => {} };
  }
  const model = createHostedBotsMatrixModel(options);
  try {
    const stop = await bindHostedBotsDriveSocket(options.socketPath ?? SOCKET, model.routes);
    return { issue: model.issue, close: async () => { model.close(); await stop(); } };
  } catch (error) {
    model.close();
    console.warn("[hosted-bots] Could not start Matrix model bridge", error instanceof Error ? error.name : "UnknownError");
    return { issue: undefined, close: async () => {} };
  }
}
