import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { ManagedWorkersAiModelId, AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { generateApiAppText } from "../app-ai/api-completion.js";
import { projectAppAiAuthorizationRoutes } from "../app-ai/connected-routes.js";
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
const id = z.string().regex(/^[\w-]{1,128}$/u);
const sendId = z.string().regex(/^[\w-]{16,80}$/u);
const turnIdentity = z.strictObject({ botId: id, threadId: id, sendId });
type Identity = z.infer<typeof turnIdentity>;
const directSend = z.strictObject({ threadId: id, sendId, text: z.string().trim().min(1).max(MAX_TEXT) });
const redeemTurn = turnIdentity.extend({
  modelId: z.literal(MATRIX_BOTS_MODEL_ID),
  history: z.array(z.strictObject({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(1000),
  })).max(12),
});
const route = {
  harnessId: "matrix_ai", accountId: null, accessSourceId: "matrix_cloudflare", modelId: MATRIX_BOTS_MODEL_ID,
} as const;

type OwnerSendTicket = (identity: Identity, text: string) => string | undefined;

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

type Options = Pick<Parameters<typeof generateApiAppText>[0],
  "homePath" | "fetchImpl" | "fundedCredentialProvider" | "fundedAdmission"
> & { inventory: () => Promise<AiProviderSnapshotV3> };

export function createHostedBotsMatrixModel(options: Options) {
  const tickets = new Map<string, { identity: Identity; text: string; expiresAt: number }>();
  const lifecycle = new AbortController();
  const app = new Hono();
  let status: { at: number; available: boolean } | undefined;
  let statusRead: Promise<boolean> | undefined;
  function expire(now = Date.now()) {
    for (const [token, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(token);
  }
  const expires = setInterval(expire, 5_000);
  expires.unref();
  async function revalidate() {
    return !lifecycle.signal.aborted && Boolean(options.fundedCredentialProvider?.enabled && options.fundedAdmission)
      && projectAppAiAuthorizationRoutes(undefined, await options.inventory()).routes.some(candidate =>
        candidate.harnessId === route.harnessId && candidate.accountId === route.accountId
        && candidate.accessSourceId === route.accessSourceId && candidate.modelId === route.modelId
        && candidate.availability === "available");
  }
  function warn(error: unknown) {
    console.warn("[hosted-bots] Matrix model unavailable", error instanceof Error ? error.name : "UnknownError");
  }
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });
  app.get("/status", async (c) => {
    if (lifecycle.signal.aborted) return c.json({ available: false });
    if (status && Date.now() - status.at < STATUS_TTL_MS) return c.json({ available: status.available });
    statusRead ??= revalidate().catch((error: unknown) => { warn(error); return false; }).then((available) => {
      status = { available, at: Date.now() };
      return available;
    }).finally(() => { statusRead = undefined; });
    return c.json({ available: await statusRead });
  });
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
      if (!await revalidate()) return c.json({ error: "unavailable" }, 503);
      const prompt = JSON.stringify({
        previousConversation: body.data.history, currentUserMessage: ticket.text,
      });
      const result = await generateApiAppText({
        ...options, route, prompt, revalidate, signal: AbortSignal.any([lifecycle.signal, c.req.raw.signal]),
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
      if (lifecycle.signal.aborted || !options.fundedCredentialProvider?.enabled || !options.fundedAdmission) return undefined;
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
  if (!options.admitted || !options.fundedCredentialProvider?.enabled || !options.fundedAdmission) {
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
