// Installed in the pinned OpenMausBot server/drivers directory at build time.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import type { RuntimeEvent, RuntimeEventListener } from "../../shared/runtime-events.ts";
import { newEventId, type InstanceConfigMap, type ProviderAdapter, type ProviderDriver } from "../contracts.ts";

export const MATRIX_HOSTED_INSTANCE = "matrix-hosted-ai";
export const MATRIX_HOSTED_MODEL = "@cf/zai-org/glm-5.3-flash";
const DISPLAY = "Matrix AI · Text only";
const MODEL_SOCKET = "/matrix-drive/model.sock";
const RESPONSE_LIMIT = 256_000;
const SEND_NOTICE = "Matrix AI accepts a new, direct text message from the paired Matrix Bots window. Queued messages, attachments, and automated turns are not supported.";

type TurnIdentity = { botId: string; threadId: string; sendId: string };
export type MatrixHostedTurnTicket = TurnIdentity & { token: string };
const ownerSend = new AsyncLocalStorage<MatrixHostedTurnTicket | null>();
const modelTurn = new AsyncLocalStorage<MatrixHostedTurnTicket | null>();

export function withMatrixHostedOwnerSend<T>(
  header: string | string[] | undefined, identity: TurnIdentity, work: () => T,
): T {
  const ticket = typeof header === "string" && /^[a-f0-9]{64}$/.test(header) ? { ...identity, token: header } : null;
  return ownerSend.run(ticket, work);
}

export function takeMatrixHostedOwnerSend(
  botId: string, threadId: string, sendId: string | undefined,
): MatrixHostedTurnTicket | undefined {
  const owner = ownerSend.getStore();
  if (!owner?.token || owner.botId !== botId || owner.threadId !== threadId || owner.sendId !== sendId) return undefined;
  const turn = { ...owner };
  owner.token = "";
  return turn;
}

/** Only the immediate, non-queued owner dispatch passes a ticket here. */
export function runMatrixHostedModelTurn<T>(
  instanceId: string, ticket: MatrixHostedTurnTicket | undefined, work: () => T,
): T {
  return modelTurn.run(instanceId === MATRIX_HOSTED_INSTANCE && ticket ? ticket : null, work);
}

export function matrixHostedProviderConfigs(configs: InstanceConfigMap): InstanceConfigMap {
  if (!process.env.OMB_MATRIX_PAIR_SOCKET) return configs;
  return { ...configs, [MATRIX_HOSTED_INSTANCE]: {
    driver: MATRIX_HOSTED_INSTANCE, displayName: DISPLAY, enabled: true, access: "subscription",
  } };
}

async function query(
  path: "/status" | "/turn", signal: AbortSignal, body?: string, token?: string,
): Promise<unknown> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({
      socketPath: MODEL_SOCKET, path, method: body === undefined ? "GET" : "POST", agent: false, signal,
      headers: body === undefined ? {} : {
        "content-type": "application/json", "content-length": Buffer.byteLength(body),
        authorization: "Bearer " + token,
      },
    }, resolve);
    req.once("error", reject);
    req.end(body);
  });
  try {
    if (response.statusCode !== 200) throw new Error("Matrix AI unavailable");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of response) {
      const chunk = Buffer.from(part);
      size += chunk.length;
      if (size > RESPONSE_LIMIT) throw new Error("Matrix AI response limit");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    response.destroy();
  }
}

const models = {
  default: MATRIX_HOSTED_MODEL,
  options: [{ id: MATRIX_HOSTED_MODEL, label: "GLM 5.3 Flash · Text only" }],
};

export const matrixHostedDriver: ProviderDriver<null> = {
  driverKind: MATRIX_HOSTED_INSTANCE,
  metadata: { displayName: DISPLAY, access: "subscription" },
  models,
  defaultConfig: () => null,
  decodeConfig: () => null,
  async create({ instanceId, enabled }) {
    if (!process.env.OMB_MATRIX_PAIR_SOCKET || instanceId !== MATRIX_HOSTED_INSTANCE) throw new Error("Matrix AI unavailable");
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { turnId: string; abort: AbortController }>();
    let stopped = false;
    const stopAll = async () => {
      for (const turn of active.values()) turn.abort.abort();
      active.clear();
    };
    const adapter: ProviderAdapter = {
      provider: MATRIX_HOSTED_INSTANCE,
      capabilities: { sessionModelSwitch: "unsupported" },
      async sendTurn(input) {
        const ticket = modelTurn.getStore();
        if (stopped || !enabled || !ticket?.token || input.model !== MATRIX_HOSTED_MODEL
          || ticket.botId !== input.botId || ticket.threadId !== input.threadId
          || input.guestConfined || input.mentionTurn || input.images?.length) throw new Error(SEND_NOTICE);
        if (active.has(input.threadId) || active.size >= 8) throw new Error("Matrix AI is busy. Send a new message when the turn finishes.");
        const token = ticket.token;
        ticket.token = "";
        const turnId = randomUUID();
        const abort = new AbortController();
        active.set(input.threadId, { turnId, abort });
        const base = () => ({
          eventId: newEventId(), provider: MATRIX_HOSTED_INSTANCE, providerInstanceId: instanceId,
          threadId: input.threadId, turnId, createdAt: new Date().toISOString(),
        });
        const emit = (event: RuntimeEvent) => {
          for (const listener of listeners) listener(event);
        };
        emit({ ...base(), type: "turn.started" });
        emit({ ...base(), type: "session.started", sessionId: null, model: MATRIX_HOSTED_MODEL });
        void (async () => {
          let ok = false;
          let stopReason = "error";
          try {
            // The gateway supplies the exact latest user text from its
            // authorized request, not mutable turn input or private context.
            const history = (input.transcript ?? [])
              .filter(line => line.role === "user" || line.role === "assistant")
              .slice(-12).map(({ role, text }) => ({ role, text: text.slice(0, 1_000) }));
            const result = await query("/turn", AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]), JSON.stringify({
              botId: ticket.botId, threadId: ticket.threadId, sendId: ticket.sendId, modelId: MATRIX_HOSTED_MODEL, history,
            }), token);
            abort.signal.throwIfAborted();
            const text = result && typeof result === "object" && "text" in result ? result.text : null;
            if (typeof text !== "string" || !text.trim() || text.length > 64_000) throw new Error("Matrix AI invalid reply");
            emit({ ...base(), type: "item.completed", itemType: "assistant_text", text });
            ok = true;
            stopReason = "end_turn";
          } catch (error) {
            if (abort.signal.aborted) stopReason = "interrupted";
            else {
              console.warn("[matrix-ai] Text turn failed", error instanceof Error ? error.name : "UnknownError");
              emit({ ...base(), type: "runtime.error", message: "Matrix AI could not complete this message. Send a new message to retry." });
            }
          } finally {
            if (active.get(input.threadId)?.turnId === turnId) active.delete(input.threadId);
            emit({ ...base(), type: "turn.completed", ok, stopReason, cost: null });
          }
        })();
        return { turnId };
      },
      async interruptTurn(threadId, turnId) {
        const turn = active.get(threadId);
        if (turn && (turnId === undefined || turn.turnId === turnId)) turn.abort.abort();
      },
      async respondToRequest() { return "unavailable"; },
      hasSession: () => false,
      stopAll,
      onEvent(listener) {
        // As with the stock adapters, only the server event bus subscribes here.
        if (listeners.size >= 4) throw new Error("Matrix AI too many event listeners");
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    return {
      instanceId, driverKind: MATRIX_HOSTED_INSTANCE, displayName: DISPLAY, enabled, models, adapter,
      async snapshot() {
        if (!enabled || stopped) return { state: "unavailable", reason: "Matrix AI unavailable" };
        try {
          const status = await query("/status", AbortSignal.timeout(5_000));
          if (status && typeof status === "object" && "available" in status && status.available === true) {
            return { state: "available", authenticated: true, billing: "metered" };
          }
        } catch (error) {
          console.warn("[matrix-ai] Status unavailable", error instanceof Error ? error.name : "UnknownError");
        }
        return { state: "unavailable", reason: "Matrix AI unavailable for this Matrix Computer" };
      },
      async dispose() { stopped = true; await stopAll(); listeners.clear(); },
    };
  },
};
