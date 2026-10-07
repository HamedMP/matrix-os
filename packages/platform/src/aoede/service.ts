import { createHmac, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { WebSocket } from "ws";
import { z } from "zod/v4";
import type { PlatformDB, PlatformDatabase } from "../db.js";
import type { SpeechFundingPort } from "../speech/service.js";

export const LiveProviderId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const HistoryItem = z.object({ role: z.enum(["user", "assistant", "developer"]),
  content: z.array(z.object({ type: z.enum(["input_text", "text", "output_text"]), text: z.string().max(16_000) }).strict()).length(1),
  type: z.literal("message").optional() }).strict();
export const LiveMintInput = z.object({ clientRequestId: z.uuid(), sdp: z.string().min(1).max(60_000),
  instructions: z.string().min(1).max(8_000), input: z.array(HistoryItem).max(24) }).strict()
  .refine((v) => Buffer.byteLength(v.instructions) <= 8_000
    && v.input.reduce((n, item) => n + Buffer.byteLength(item.content[0].text), 0) <= 6_000);
export interface LiveIdentity { ownerId: string; machineId: string; runtimeSlot: string; runtimeTokenEpoch: number }
export interface LivePolicy { enabled: boolean; model: "gpt-live-1"; voice: string; revision: string; microusdPerMinute: number; maxDurationMs: number }
export class AoedeLiveError extends Error {
  constructor(readonly code: "unavailable" | "conflict" | "not_found" = "unavailable") { super("Voice session unavailable"); }
}
const EVENTS = new Set(["session.started", "session.updated", "session.closed", "session.usage.updated",
  "session.input_transcript.delta", "session.output_transcript.delta", "session.delegation.created",
  "session.instructions.appended", "session.thinking.appended", "session.commentary.appended", "error", "info"]);
const Event = z.object({ type: z.string().max(80), event_id: LiveProviderId.optional(),
  usage: z.object({ seconds: z.number().nonnegative().finite() }).optional(),
  session: z.object({ id: LiveProviderId, expires_at: z.number().positive().finite().optional() }).optional(),
  delta: z.string().max(16_000).optional(), start_ms: z.number().nonnegative().optional(),
  end_ms: z.number().nonnegative().optional(), offset_ms: z.number().nonnegative().optional(),
  delegation: z.object({ id: LiveProviderId, target: z.literal("client"), type: z.literal("delegation") }).optional(),
}).passthrough();
const COMMAND = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.close"), event_id: LiveProviderId.optional() }).strict(),
  ...["session.instructions.append", "session.thinking.append", "session.commentary.append"].map((type) =>
    z.object({ type: z.literal(type), content: z.string().min(1).max(2_000),
      delegation_id: LiveProviderId.nullable(), event_id: LiveProviderId.optional() }).strict()),
]);
interface Control {
  socket: WebSocket; timer: ReturnType<typeof setTimeout>; completion: Promise<void>;
  finish(): void; closing?: Promise<void>; client?: (event: string) => void; disconnect?: () => void;
}

export function createPlatformAoedeLiveService(options: {
  db: PlatformDB; funding: SpeechFundingPort; policy: LivePolicy; apiKey: string; fingerprintSecret: string;
  fetchImpl?: typeof fetch; connect?: (providerId: string) => WebSocket; finalizationTimeoutMs?: number;
}) {
  const { db, funding, policy } = options;
  const deadline = options.finalizationTimeoutMs ?? 15_000;
  if (options.fingerprintSecret.length < 32 || options.apiKey.length < 16 || policy.model !== "gpt-live-1"
    || !Number.isSafeInteger(policy.maxDurationMs) || policy.maxDurationMs < 30_000 || policy.maxDurationMs > 30 * 60_000
    || !Number.isSafeInteger(policy.microusdPerMinute) || policy.microusdPerMinute < 1 || policy.microusdPerMinute > 1_000_000_000
    || deadline < 1 || deadline > 15_000 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(policy.revision)
    || !/^[a-z]{1,40}$/.test(policy.voice)) throw new Error("Invalid Live policy");
  const controls = new Map<string, Control>();
  const tasks = new Set<Promise<unknown>>();
  let stopping = false;
  const shutdownController = new AbortController();
  const maximumCost = Math.ceil((policy.maxDurationMs + 45_000) * policy.microusdPerMinute / 60_000);
  const connect = options.connect ?? ((id: string) => new WebSocket(
    `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/attach`, {
      headers: { Authorization: `Bearer ${options.apiKey}` }, handshakeTimeout: 10_000,
      maxPayload: 512 * 1024, perMessageDeflate: false,
    }));
  const query = (id: string) => db.executor.selectFrom("speech_operations").selectAll()
    .where("adapter_id", "=", "aoede-live").where("live_provider_id", "=", id);
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task);
    void task.then(() => tasks.delete(task), (error: unknown) => { tasks.delete(task); report(error); });
    return task;
  };
  function report(error: unknown) { console.warn("[aoede-live] lifecycle failure", error instanceof Error ? error.name : "UnknownError"); }
  async function bound(identity: LiveIdentity, id: string) {
    const row = await query(LiveProviderId.parse(id)).executeTakeFirst();
    if (!row || row.owner_id !== identity.ownerId || row.machine_id !== identity.machineId
      || row.runtime_slot !== identity.runtimeSlot || row.live_runtime_epoch !== identity.runtimeTokenEpoch
      || !row.funding_reservation_id) throw new AoedeLiveError("not_found");
    return row;
  }
  async function finalize(operationId: string, seconds?: number) {
    await db.transaction(async (trx) => {
      const row = await trx.executor.selectFrom("speech_operations").selectAll()
        .where("operation_id", "=", operationId).where("adapter_id", "=", "aoede-live").forUpdate().executeTakeFirstOrThrow();
      if (row.live_confirmed || row.execution_state === "cancelled") return;
      const validFinal = seconds !== undefined && Number.isFinite(seconds) && seconds >= 0;
      const cost = validFinal ? Math.ceil(seconds * Number(row.live_rate_microusd_per_minute) / 60) : Number(row.reserved_microusd);
      const exact = validFinal && cost <= Number(row.reserved_microusd);
      if (row.execution_state === "dispatching") {
        await funding.settle(trx.executor as Transaction<PlatformDatabase>, row.funding_reservation_id!, exact
          ? { mode: "exact", actualCostMicrousd: cost } : { mode: "conservative" });
      }
      if (validFinal && !exact) console.warn("[aoede-live] final usage exceeds reservation; accounting reconciliation required");
      await trx.executor.updateTable("speech_operations").set({
        live_confirmed: validFinal && exact, ...(validFinal ? { live_usage_seconds: seconds } : {}),
        execution_state: row.execution_state === "uncertain" || !exact ? "uncertain" : "succeeded",
        safe_outcome_code: row.execution_state === "uncertain" || !exact ? "provider_failure" : "no_speech",
        actual_microusd: row.execution_state === "uncertain" || !exact ? Number(row.reserved_microusd) : cost,
        updated_at: new Date().toISOString(),
      }).where("operation_id", "=", operationId).where("adapter_id", "=", "aoede-live").execute();
    });
  }
  async function open(id: string, operationId: string, expiresAt: string): Promise<Control> {
    if (controls.has(id) || controls.size >= 16) throw new AoedeLiveError("conflict");
    const socket = connect(id);
    const done = Promise.withResolvers<void>();
    let queue = Promise.resolve();
    let pending = 0;
    let queuedBytes = 0;
    let ended = false;
    const control: Control = { socket, completion: done.promise, finish: () => done.resolve(),
      timer: setTimeout(() => requestClose(), Math.max(10_001, Date.parse(expiresAt) - Date.now())) };
    control.timer.unref?.();
    controls.set(id, control);
    const dispose = () => {
      if (ended) return;
      ended = true;
      clearTimeout(control.timer);
      controls.delete(id);
      control.client = undefined;
      control.disconnect?.();
      socket.terminate();
      done.resolve();
    };
    control.finish = dispose;
    const requestClose = () => {
      if (ended || control.closing) return;
      void track(closeControl(id, control)).catch(report);
    };
    socket.on("message", (raw, binary) => {
      // Reflected media never reaches the runtime and is not retained in the persistence queue.
      if (binary || Buffer.byteLength(raw.toString()) > 512 * 1024) { requestClose(); return; }
      let decoded: unknown;
      try { decoded = JSON.parse(raw.toString()); } catch (error) { report(error); requestClose(); return; }
      if (!decoded || typeof decoded !== "object" || !("type" in decoded) || !EVENTS.has(String(decoded.type))) return;
      const parsed = Event.safeParse(decoded);
      if (!parsed.success) { requestClose(); return; }
      const event = parsed.data;
      if (event.session?.id && event.session.id !== id) return;
      const text = JSON.stringify(event);
      const size = Buffer.byteLength(text);
      if (pending >= 64 || size > 64 * 1024 || queuedBytes + size > 256 * 1024) { requestClose(); return; }
      pending++; queuedBytes += size;
      queue = queue.then(async () => {
        if (event.type === "session.closed") {
          await finalize(operationId, event.usage?.seconds);
          control.client?.(text);
          dispose();
          return;
        }
        if (event.type === "session.usage.updated" && Number.isFinite(event.usage?.seconds) && event.usage!.seconds! >= 0) {
          await db.executor.updateTable("speech_operations").set({ live_usage_seconds: event.usage!.seconds! })
            .where("operation_id", "=", operationId).where("execution_state", "=", "dispatching").execute();
        }
        if (event.session?.expires_at && Number.isFinite(event.session.expires_at)) {
          clearTimeout(control.timer);
          control.timer = setTimeout(requestClose,
            Math.max(1, Math.min(Date.parse(expiresAt), event.session.expires_at * 1_000) - Date.now()));
          control.timer.unref?.();
        }
        control.client?.(text);
      }).catch((error) => { report(error); requestClose(); }).finally(() => { pending--; queuedBytes -= size; });
    });
    let disconnecting = false;
    const disconnected = () => {
      if (ended || disconnecting) return;
      disconnecting = true;
      void track(queue.then(() => finalize(operationId)).finally(dispose)).catch(report);
    };
    socket.on("close", disconnected);
    socket.on("error", disconnected);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new AoedeLiveError()); }, 10_000);
        socket.once("open", () => { clearTimeout(timer); resolve(); });
        socket.once("error", () => { clearTimeout(timer); reject(new AoedeLiveError()); });
      });
      clearTimeout(control.timer);
      control.timer = setTimeout(requestClose, Math.max(1, Date.parse(expiresAt) - Date.now()));
      control.timer.unref?.();
      return control;
    } catch (error) { await finalize(operationId); dispose(); throw error; }
  }
  async function closeControl(id: string, control: Control) {
    if (control.closing) return control.closing;
    control.closing = (async () => {
      clearTimeout(control.timer);
      if (control.socket.readyState === WebSocket.OPEN) control.socket.send(JSON.stringify({ type: "session.close" }));
      let timer: ReturnType<typeof setTimeout>;
      await Promise.race([control.completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, deadline); })]);
      clearTimeout(timer!);
      const row = await query(id).executeTakeFirst();
      if (row && !row.live_confirmed) await finalize(row.operation_id);
      control.socket.terminate();
      controls.delete(id);
      control.finish();
    })();
    return control.closing;
  }
  async function mint(identity: LiveIdentity, rawInput: unknown, signal?: AbortSignal) {
    if (stopping || signal?.aborted || !policy.enabled || controls.size >= 16 || tasks.size >= 32) throw new AoedeLiveError();
    const input = LiveMintInput.parse(rawInput);
    const fingerprint = createHmac("sha256", options.fingerprintSecret).update(JSON.stringify(input)).digest("hex");
    const replay = await db.executor.selectFrom("speech_operations").select("operation_id")
      .where("adapter_id", "=", "aoede-live").where("owner_id", "=", identity.ownerId)
      .where("operation_id", "=", input.clientRequestId).executeTakeFirst();
    if (replay) throw new AoedeLiveError("conflict");
    const old = await db.executor.selectFrom("speech_operations").selectAll().where("owner_id", "=", identity.ownerId)
      .where("adapter_id", "=", "aoede-live").where("live_confirmed", "=", false).where("execution_state", "!=", "cancelled").executeTakeFirst();
    if (old) {
      if (old.operation_id === input.clientRequestId || !old.live_provider_id || old.execution_state !== "dispatching") throw new AoedeLiveError("conflict");
      const control = controls.get(old.live_provider_id) ?? await open(old.live_provider_id, old.operation_id, old.expires_at);
      await closeControl(old.live_provider_id, control);
    }
    const expiresAt = new Date(Date.now() + policy.maxDurationMs).toISOString();
    await db.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('aoede-live-admission'))`.execute(trx.executor);
      const machine = await trx.executor.selectFrom("user_machines").select("runtime_token_epoch")
        .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirst();
      if (machine?.runtime_token_epoch !== identity.runtimeTokenEpoch) throw new AoedeLiveError();
      const count = await trx.executor.selectFrom("speech_operations").select("operation_id")
        .where("adapter_id", "=", "aoede-live").where("live_confirmed", "=", false).where("execution_state", "in", ["reserved", "dispatching"]).limit(16).execute();
      if (count.length >= 16) throw new AoedeLiveError("conflict");
      const recent = await trx.executor.selectFrom("speech_operations").select("operation_id").where("owner_id", "=", identity.ownerId)
        .where("adapter_id", "=", "aoede-live").where("created_at", ">", new Date(Date.now() - 60_000).toISOString()).limit(10).execute();
      if (recent.length >= 10) throw new AoedeLiveError("conflict");
      const now = new Date().toISOString();
      // The unique owner fence and primary key serialize all processes, not just this controller map.
      await trx.executor.insertInto("speech_operations").values({
        owner_id: identity.ownerId, machine_id: identity.machineId, runtime_slot: identity.runtimeSlot,
        operation_id: input.clientRequestId, source_kind: null, content_fingerprint: fingerprint,
        policy_revision: policy.revision, adapter_id: "aoede-live", model_id: policy.model,
        funding_reservation_id: null, execution_state: "reserved", cancellation_requested: false, tombstone: false,
        dispatch_claimed_at: null, safe_outcome_code: null, audio_duration_ms: null, reserved_microusd: maximumCost,
        actual_microusd: null, created_at: now, updated_at: now, expires_at: expiresAt,
        live_runtime_epoch: identity.runtimeTokenEpoch,
        live_rate_microusd_per_minute: policy.microusdPerMinute,
      }).execute();
      const reservation = await funding.reserve(trx.executor as Transaction<PlatformDatabase>, { identity: { ownerId: identity.ownerId, machineId: identity.machineId,
        runtimeSlot: identity.runtimeSlot }, requestId: input.clientRequestId, policyRevision: policy.revision,
        modelId: policy.model, maximumCostMicrousd: maximumCost });
      await trx.executor.updateTable("speech_operations").set({ funding_reservation_id: reservation.reservationId })
        .where("operation_id", "=", input.clientRequestId).where("owner_id", "=", identity.ownerId).execute();
    });
    let dispatched = false;
    let providerId: string | undefined;
    try {
      if (stopping || signal?.aborted) throw new AoedeLiveError();
      await db.transaction(async (trx) => {
        const row = await trx.executor.selectFrom("speech_operations").selectAll().where("operation_id", "=", input.clientRequestId)
          .where("owner_id", "=", identity.ownerId).forUpdate().executeTakeFirstOrThrow();
        await funding.start(trx.executor as Transaction<PlatformDatabase>, row.funding_reservation_id!);
        await trx.executor.updateTable("speech_operations").set({ execution_state: "dispatching", dispatch_claimed_at: new Date().toISOString() })
          .where("operation_id", "=", input.clientRequestId).where("execution_state", "=", "reserved").execute();
      });
      dispatched = true;
      const response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/live/sessions", {
        method: "POST", redirect: "error", signal: AbortSignal.any([
          shutdownController.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : []),
        ]),
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: { model: policy.model, instructions: input.instructions, input: input.input,
          store: false, audio: { output: { voice: policy.voice } }, delegation: { type: "client" },
          client: { data_channel: { allowed_client_events: ["session.close"], allowed_server_events:
            ["session.started", "session.input_transcript.delta", "session.output_transcript.delta", "session.closed", "error", "info"].map((type) => ({ type })) } } },
          transport: { type: "webrtc", sdp: input.sdp } }),
      });
      if (response.status !== 201 || !response.body) { await response.body?.cancel(); throw new AoedeLiveError(); }
      const reader = response.body.getReader();
      let text = ""; let bytes = 0; const decoder = new TextDecoder();
      try {
        for (;;) { const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > 64 * 1024) throw new AoedeLiveError(); text += decoder.decode(part.value, { stream: true }); }
      } finally { await reader.cancel(); }
      const result = z.object({ session: z.object({ id: LiveProviderId }),
        transport: z.object({ type: z.literal("webrtc"), sdp: z.string().min(1).max(60_000) }) }).parse(JSON.parse(text + decoder.decode()));
      providerId = result.session.id;
      if (signal?.aborted) throw new AoedeLiveError();
      await db.executor.updateTable("speech_operations").set({ live_provider_id: providerId })
        .where("operation_id", "=", input.clientRequestId).where("owner_id", "=", identity.ownerId).executeTakeFirstOrThrow();
      await open(providerId, input.clientRequestId, expiresAt);
      if (stopping || signal?.aborted) throw new AoedeLiveError();
      return { providerSessionId: providerId, sdp: result.transport.sdp };
    } catch (error) {
      if (dispatched) {
        // If persistence failed after creation, attach by the trusted REST ID solely for compensating closure.
        if (providerId) {
          try { const control = controls.get(providerId) ?? await open(providerId, input.clientRequestId, expiresAt); await closeControl(providerId, control); }
          catch (compensationError) { report(compensationError); }
        }
        await finalize(input.clientRequestId);
      } else {
        await db.transaction(async (trx) => {
          const row = await trx.executor.selectFrom("speech_operations").selectAll().where("operation_id", "=", input.clientRequestId)
            .where("owner_id", "=", identity.ownerId).forUpdate().executeTakeFirstOrThrow();
          await funding.release(trx.executor as Transaction<PlatformDatabase>, row.funding_reservation_id!);
          await trx.executor.updateTable("speech_operations").set({ execution_state: "cancelled", cancellation_requested: true,
            safe_outcome_code: "cancelled", live_confirmed: true }).where("operation_id", "=", input.clientRequestId).execute();
        });
      }
      report(error); throw new AoedeLiveError();
    }
  }
  async function bind(identity: LiveIdentity, id: string) {
    const row = await bound(identity, id);
    if (stopping || row.live_confirmed || row.execution_state !== "dispatching") throw new AoedeLiveError("conflict");
    const attachmentId = randomUUID();
    const claimed = await db.executor.updateTable("speech_operations").set({ live_attachment_id: attachmentId })
      .where("live_provider_id", "=", id).where("live_attachment_id", "is", null)
      .where("execution_state", "=", "dispatching").where("live_confirmed", "=", false)
      .returning("operation_id").executeTakeFirst();
    if (!claimed) throw new AoedeLiveError("conflict");
    const clearAttachment = () => db.executor.updateTable("speech_operations").set({ live_attachment_id: null })
      .where("live_provider_id", "=", id).where("live_attachment_id", "=", attachmentId).execute();
    let control: Control;
    try {
      // Cloud Run may route the upgrade to a different process from REST mint.
      // That process opens its own billing observer; the SQL claim still permits only one runtime controller.
      control = controls.get(id) ?? await open(id, row.operation_id, row.expires_at);
      if (control.closing || control.client) throw new AoedeLiveError("conflict");
    } catch (error) { await clearAttachment(); throw error; }
    const placeholder = () => undefined;
    control.client = placeholder;
    let released = false;
    return {
      subscribe(listener: (event: string) => void, disconnect?: () => void) {
        if (released || control.client !== placeholder) throw new AoedeLiveError("conflict");
        control.client = listener; control.disconnect = disconnect; },
      send(raw: string) { const command = COMMAND.parse(JSON.parse(raw));
        if (command.type === "session.close") {
          if (!control.closing) void track(closeControl(id, control)).catch(report);
          return;
        }
        if (control.closing || control.socket.readyState !== WebSocket.OPEN || control.socket.bufferedAmount > 512 * 1024) throw new AoedeLiveError();
        control.socket.send(JSON.stringify(command)); },
      release() { if (released) return; released = true; control.client = undefined; control.disconnect = undefined;
        void track(clearAttachment().then(() => closeControl(id, control))).catch(report); },
    };
  }
  async function close(identity: LiveIdentity, id: string) {
    const row = await bound(identity, id);
    if (row.live_confirmed) return { closed: true, finalization: "confirmed" as const };
    const control = controls.get(id) ?? await open(id, row.operation_id, row.expires_at);
    await closeControl(id, control);
    const finished = await query(id).executeTakeFirstOrThrow();
    return { closed: finished.live_confirmed, finalization: finished.live_confirmed ? "confirmed" as const : "unconfirmed" as const };
  }
  async function reconcile() {
    const rows = await db.executor.selectFrom("speech_operations").selectAll().where("adapter_id", "=", "aoede-live")
      .where("live_confirmed", "=", false).where("execution_state", "in", ["reserved", "dispatching", "uncertain"])
      .where("expires_at", "<=", new Date().toISOString()).orderBy("updated_at").limit(16).execute();
    await Promise.all(rows.map(async (row) => {
      if (row.execution_state === "reserved") {
        await db.transaction(async (trx) => {
          const locked = await trx.executor.selectFrom("speech_operations").selectAll().where("operation_id", "=", row.operation_id)
            .where("owner_id", "=", row.owner_id).forUpdate().executeTakeFirstOrThrow();
          if (locked.execution_state !== "reserved") return;
          await funding.release(trx.executor as Transaction<PlatformDatabase>, locked.funding_reservation_id!);
          await trx.executor.updateTable("speech_operations").set({ execution_state: "cancelled", cancellation_requested: true,
            safe_outcome_code: "cancelled", live_confirmed: true }).where("operation_id", "=", row.operation_id).execute();
        });
      } else if (row.live_provider_id) {
        try { const control = controls.get(row.live_provider_id) ?? await open(row.live_provider_id, row.operation_id, row.expires_at);
          await closeControl(row.live_provider_id, control); } catch (error) { report(error); await finalize(row.operation_id); }
      } else await finalize(row.operation_id);
    }));
  }
  let sweep: Promise<void> | undefined;
  const timer = setInterval(() => { if (!sweep && !stopping) { sweep = track(reconcile()).catch(report).finally(() => { sweep = undefined; }); } }, 30_000);
  timer.unref?.();
  return { mint: (identity: LiveIdentity, input: unknown, signal?: AbortSignal) => track(mint(identity, input, signal)), bind, close, reconcile,
    async shutdown() { stopping = true; shutdownController.abort(); clearInterval(timer);
      await Promise.allSettled([...tasks, ...[...controls].map(([id, control]) => closeControl(id, control))]);
      while (tasks.size > 0) await Promise.allSettled([...tasks]); await sweep; } };
}
export type PlatformAoedeLiveService = ReturnType<typeof createPlatformAoedeLiveService>;
