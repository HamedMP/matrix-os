// Installed in the pinned OpenMausBot server/drivers directory at build time.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { request, type IncomingMessage } from "node:http";
import type { RuntimeEvent, RuntimeEventListener } from "../../shared/runtime-events.ts";
import { newEventId, type InstanceConfigMap, type ModelCatalog, type ProviderAdapter, type ProviderDriver } from "../contracts.ts";

export const MATRIX_HOSTED_INSTANCE = "matrix-hosted-ai";
export const MATRIX_HOSTED_MODEL = "@cf/zai-org/glm-5.3-flash";
const DISPLAY = "Matrix providers";
const MODEL_SOCKET = "/matrix-drive/model.sock";
const RESPONSE_LIMIT = 256_000;
const SEND_NOTICE = "Send a new, direct text message from the paired Matrix Bots window to use Matrix providers.";
const MAX_MODELS = 128;
const TEXT_TURN_TIMEOUT = 35_000;
const MANAGED_TURN_TIMEOUT = 150_000;
const STATUS_TIMEOUT = 8_000;
// Detached completion can wait through Gateway's 35s native discovery.
const COMPLETE_STATUS_TIMEOUT = 37_000;
const STATUS_TRANSPORT_GRACE = 8_000;

type TurnIdentity = { botId: string; threadId: string; sendId: string };
export type MatrixHostedTurnTicket = TurnIdentity & {
  token: string;
  schedule?: { routineId: string; modelId: string; scheduledFor: number };
};
const ownerSend = new AsyncLocalStorage<MatrixHostedTurnTicket | null>();
type HistoryLine = {
  id: string; role: string; kind: string; text?: string | null;
  automation?: unknown; peerAsk?: unknown; from?: unknown; relayed?: boolean;
};
type ContextLine = { role: "user" | "assistant"; text: string };
const modelTurn = new AsyncLocalStorage<{ ticket: MatrixHostedTurnTicket; history: ContextLine[] } | null>();

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
  instanceId: string, ticket: MatrixHostedTurnTicket | undefined,
  messages: readonly HistoryLine[], excluded: ReadonlySet<string>, work: () => T,
): T {
  if (ticket?.schedule && instanceId !== MATRIX_HOSTED_INSTANCE) throw new Error("The scheduled Matrix model has changed.");
  if (instanceId !== MATRIX_HOSTED_INSTANCE || !ticket?.token) return modelTurn.run(null, work);
  if (ticket.schedule) return modelTurn.run({ ticket, history: [] }, work);
  const history: ContextLine[] = [];
  for (let i = messages.length - 1; i >= 0 && history.length < 12; i--) {
    const line = messages[i]!;
    if (line.kind !== "text" || !line.text || excluded.has(line.id) || line.automation || line.peerAsk || line.from || line.relayed) continue;
    if (line.role === "user" || line.role === "bot") {
      history.push({ role: line.role === "user" ? "user" : "assistant", text: line.text.slice(0, 1_000) });
    }
  }
  return modelTurn.run({ ticket, history: history.reverse() }, work);
}

export function matrixHostedProviderConfigs(configs: InstanceConfigMap): InstanceConfigMap {
  if (!process.env.OMB_MATRIX_PAIR_SOCKET) return configs;
  return { ...configs, [MATRIX_HOSTED_INSTANCE]: {
    driver: MATRIX_HOSTED_INSTANCE, displayName: DISPLAY, enabled: true, access: "subscription",
  } };
}

async function query(
  path: "/status" | "/status?complete=1" | "/turn" | "/schedule/turn", signal: AbortSignal, body?: string, token?: string,
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

const emptyModels: ModelCatalog = { default: "", options: [] };
function matrixModelId(value: unknown): value is string {
  return typeof value === "string" && (value === MATRIX_HOSTED_MODEL || /^matrix-route-[a-f0-9]{64}$/.test(value));
}
function matrixModelCatalog(value: unknown): { models: ModelCatalog; tools: ReadonlySet<string> } | null {
  if (!value || typeof value !== "object" || !("available" in value) || value.available !== true
    || !("default" in value) || !matrixModelId(value.default)
    || !("models" in value) || !Array.isArray(value.models) || value.models.length > MAX_MODELS) return null;
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  const tools = new Set<string>();
  for (const option of value.models) {
    if (!option || typeof option !== "object" || !matrixModelId(option.id) || seen.has(option.id)
      || typeof option.label !== "string" || !option.label.trim() || option.label.length > 320
      || typeof option.tools !== "boolean") return null;
    seen.add(option.id);
    options.push({ id: option.id, label: option.label });
    if (option.tools) tools.add(option.id);
  }
  return seen.has(value.default) ? { models: { default: value.default, options }, tools } : null;
}

export const matrixHostedDriver: ProviderDriver<null> = {
  driverKind: MATRIX_HOSTED_INSTANCE,
  metadata: { displayName: DISPLAY, access: "subscription" },
  models: emptyModels,
  defaultConfig: () => null,
  decodeConfig: () => null,
  async create({ instanceId, enabled }) {
    if (!process.env.OMB_MATRIX_PAIR_SOCKET || instanceId !== MATRIX_HOSTED_INSTANCE) throw new Error("Matrix AI unavailable");
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { turnId: string; abort: AbortController }>();
    let catalog: ReturnType<typeof matrixModelCatalog> = null;
    let observedAt = 0;
    let stopped = false;
    let catalogCompletion: Promise<void> | undefined;
    const statusLifetime = new AbortController();
    const statusSignal = (timeout: number) => AbortSignal.any([statusLifetime.signal, AbortSignal.timeout(timeout)]);
    function observe(value: unknown) {
      if (stopped) return;
      catalog = matrixModelCatalog(value);
      observedAt = Date.now();
    }
    function completeCatalog(value: unknown) {
      if (catalogCompletion || !value || typeof value !== "object"
        || !("refreshing" in value) || value.refreshing !== true) return;
      // Upstream reuses engine health snapshots. Update the live catalog
      // getter once the same discovery completes, even during that cache.
      catalogCompletion = query("/status?complete=1", statusSignal(COMPLETE_STATUS_TIMEOUT)).then(observe)
        .catch((error: unknown) => {
          if (!stopped) console.warn("[matrix-ai] Catalog refresh unavailable", error instanceof Error ? error.name : "UnknownError");
        }).finally(() => { catalogCompletion = undefined; });
    }
    const stopAll = async () => {
      for (const turn of active.values()) turn.abort.abort();
      active.clear();
    };
    const adapter: ProviderAdapter = {
      provider: MATRIX_HOSTED_INSTANCE,
      capabilities: { sessionModelSwitch: "unsupported" },
      async sendTurn(input) {
        const dispatch = modelTurn.getStore();
        const ticket = dispatch?.ticket;
        const selected = input.model;
        if (stopped || !enabled || !dispatch || !ticket?.token || !matrixModelId(selected)
          || ticket.botId !== input.botId || ticket.threadId !== input.threadId
          || input.guestConfined || input.mentionTurn || input.images?.length) throw new Error(SEND_NOTICE);
        if (ticket.schedule && ticket.schedule.modelId !== selected) throw new Error("The scheduled Matrix model has changed.");
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
        emit({ ...base(), type: "session.started", sessionId: null, model: selected });
        void (async () => {
          let ok = false;
          let stopReason = "error";
          try {
            // The gateway supplies the exact latest user text from its
            // authorized request, not mutable turn input or private context.
            const schedule = ticket.schedule;
            const timeout = !schedule && catalog?.tools.has(selected) ? MANAGED_TURN_TIMEOUT : TEXT_TURN_TIMEOUT;
            const result = await query(schedule ? "/schedule/turn" : "/turn", AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]), JSON.stringify({
              botId: ticket.botId, threadId: ticket.threadId, modelId: selected,
              ...(schedule ? { routineId: schedule.routineId, scheduledFor: schedule.scheduledFor } : { sendId: ticket.sendId, history: dispatch.history }),
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
      instanceId, driverKind: MATRIX_HOSTED_INSTANCE, displayName: DISPLAY, enabled, adapter,
      get models() { return catalog?.models ?? emptyModels; },
      async snapshot() {
        if (!enabled || stopped) return { state: "unavailable", reason: "Matrix AI unavailable" };
        try {
          const value = await query("/status", statusSignal(STATUS_TIMEOUT));
          observe(value);
          completeCatalog(value);
        } catch (error) {
          // Keep a just-read catalog through a transient socket failure.
          // A valid empty response above always replaces it immediately.
          if (Date.now() - observedAt >= STATUS_TRANSPORT_GRACE) catalog = null;
          console.warn("[matrix-ai] Status unavailable", error instanceof Error ? error.name : "UnknownError");
        }
        if (catalog) return { state: "available", authenticated: true, billing: "metered" };
        return { state: "unavailable", reason: "Matrix AI unavailable for this Matrix Computer" };
      },
      async dispose() { stopped = true; statusLifetime.abort(); catalog = null; await stopAll(); listeners.clear(); },
    };
  },
};
