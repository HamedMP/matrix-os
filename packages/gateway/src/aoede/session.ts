import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { AoedeClientMessageSchema, AoedeServerMessageSchema, AoedeStartRequestSchema,
  type AoedeTranscript, type AoedeServerMessage, type AoedeSessionResponse } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { AoedeConflictError, type AoedeRepository, type SessionRecord, type DelegationRecord } from "./repository.js";
import type { AoedePlatformClient, AoedeSideband } from "./platform-client.js";
import { createTranscriptBuffer } from "./transcript.js";
import { buildAoedePrompt, AOEDE_GREETING } from "./prompt.js";

export class AoedeSessionError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 429 | 503 = 503) { super("Voice session unavailable"); }
}
class DelegationRejected extends AoedeSessionError {}
export type AppendKind = "instructions" | "thinking" | "commentary";
export interface AoedeDispatchContext {
  principal: RequestPrincipal; sessionId: string; delegationId: string; requestId: string;
  transcripts: AoedeTranscript[]; signal: AbortSignal;
  append(kind: AppendKind, content: string, delegationId: string | null): Promise<void>;
  emit(message: AoedeServerMessage): void;
  ui(phase: "resolve" | "execute", action: "open_app" | "close_app", target: string): Promise<UiResult>;
  record(result: Partial<Pick<DelegationRecord, "chat_id" | "run_id" | "queued_turn_id">>): Promise<void>;
}
export type AoedeSessionContext = Pick<AoedeDispatchContext, "principal" | "sessionId" | "signal" | "append" | "emit">;
type UiResult = Extract<z.infer<typeof AoedeClientMessageSchema>, { type: "aoede:ui_result" }>;
type Pending = { expected: string; resolve(value?: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Live = { row: SessionRecord; principal: RequestPrincipal; socket?: AoedeSideband; connectionId?: string;
  previousSessionId?: string;
  greeted: boolean; ended: boolean; confirmed: boolean; inFlight: number; buffer: ReturnType<typeof createTranscriptBuffer>;
  pending: Map<string, Pending>; grace: Map<string, ReturnType<typeof setTimeout>>;
  cap?: ReturnType<typeof setTimeout>; checkpoint?: ReturnType<typeof setTimeout>;
  abort: AbortController; finish?: () => void; closing?: Promise<void>; work: Promise<void>; queuedWrites: number; };
const Id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Delta = z.object({ event_id: Id, delta: z.string().max(16_000), start_ms: z.number().nonnegative(), end_ms: z.number().nonnegative() });
const Delegation = z.object({ offset_ms: z.number().nonnegative(), delegation: z.object({ id: Id, target: z.literal("client"), type: z.literal("delegation") }) });
const log = (error: unknown) => console.warn("[aoede] lifecycle failed", error instanceof Error ? error.name : "UnknownError");

export function createAoedeSessionService(options: {
  repository: AoedeRepository; platform: AoedePlatformClient;
  emit?: (ownerId: string, message: AoedeServerMessage, connectionId?: string) => void;
  dispatch?: (context: AoedeDispatchContext) => Promise<void>;
  onReady?: (context: AoedeSessionContext, previousSessionId?: string) => Promise<void>;
  onBoundClientMessage?: (principal: RequestPrincipal, connectionId: string, frame: z.infer<typeof AoedeClientMessageSchema>) => Promise<void>;
  facts?: () => Promise<readonly string[]>;
  graceMs?: number; finalizationMs?: number; appendTimeoutMs?: number; durationMs?: number;
}) {
  const repo = options.repository, platform = options.platform;
  if (repo.ownerId !== platform.ownerId || repo.runtimeId !== platform.runtimeId) throw new AoedeSessionError();
  const live = new Map<string, Live>(); // <=4: one active plus bounded finalizing sessions.
  let stopped = false, starts = 0, tail = Promise.resolve(), recovery: Promise<void> | undefined;
  const durationMs = Math.max(1, Math.min(options.durationMs ?? 600_000, 600_000));
  const expirySweep = setInterval(() => { void repo.expireRecovery().catch(log); }, 3_600_000);
  expirySweep.unref();
  async function exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (starts >= 4) throw new AoedeSessionError(429);
    starts++; const result = tail.then(task); tail = result.then(() => {}, () => {});
    try { return await result; } finally { starts--; }
  }
  function auth(p: RequestPrincipal) { if (p.userId !== repo.ownerId) throw new AoedeSessionError(403); }
  function emit(s: Live, message: AoedeServerMessage) {
    if (message.sessionId !== s.row.id) throw new AoedeSessionError(409);
    options.emit?.(repo.ownerId, AoedeServerMessageSchema.parse(message), s.connectionId);
  }
  function active(s: Live) { return !s.ended && !s.closing && s.row.state === "active" && !stopped; }
  function tracked(s: Live, task: () => Promise<void>) {
    if (s.queuedWrites >= 16) return s.work;
    s.queuedWrites++;
    s.work = s.work.then(task).catch(log).finally(() => { s.queuedWrites--; }); return s.work;
  }
  function flush(s: Live) { return repo.checkpoint(s.row.id, s.buffer.snapshot(), s.row.checkpoint_epoch); }
  function pending(s: Live, id: string, expected: string, send: () => void): Promise<unknown> {
    if (!active(s) || s.pending.size >= 16) return Promise.reject(new AoedeSessionError(409));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { s.pending.delete(id); reject(new AoedeSessionError()); }, options.appendTimeoutMs ?? 5_000);
      s.pending.set(id, { expected, resolve, reject, timer });
      try { send(); } catch (error) { clearTimeout(timer); s.pending.delete(id); reject(error); }
    });
  }
  async function append(s: Live, kind: AppendKind, content: string, delegationId: string | null) {
    // Conservative UTF-8 bound; acceptance is not playback. Transport uncertainty never resends.
    if (!["instructions", "thinking", "commentary"].includes(kind) || !content || Buffer.byteLength(content) > 500) throw new AoedeSessionError(409);
    if (delegationId !== null) Id.parse(delegationId);
    const send = async (delegation: string | null) => {
      const id = randomUUID();
      await pending(s, id, `session.${kind}.appended`, () => s.socket!.send({
        type: `session.${kind}.append`, event_id: id, delegation_id: delegation, content,
      }));
    };
    try { await send(delegationId); }
    catch (error) {
      if (!(error instanceof DelegationRejected) || delegationId === null) throw error;
      await send(null); // One new command only after the provider explicitly rejected this command's delegation field.
    }
  }
  function dispose(s: Live) {
    s.ended = true; s.abort.abort(); clearTimeout(s.cap); clearTimeout(s.checkpoint);
    for (const timer of s.grace.values()) clearTimeout(timer); s.grace.clear();
    for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(new AoedeSessionError(409)); }
    s.pending.clear(); s.socket?.close(); live.delete(s.row.id);
  }
  async function closeLive(s: Live, state: "closed" | "interrupted" | "superseded" = "closed") {
    if (s.closing) return s.closing;
    s.closing = (async () => {
      s.abort.abort(); clearTimeout(s.cap); clearTimeout(s.checkpoint);
      for (const timer of s.grace.values()) clearTimeout(timer); s.grace.clear();
      for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(new AoedeSessionError(409)); } s.pending.clear();
      await s.work;
      try { await flush(s); } catch (error) { log(error); }
      s.row.state = state === "closed" ? "closing" : state;
      try { await repo.beginClose(s.row.id, s.row.state); } catch (error) { log(error); }
      try { emit(s, { type: "aoede:state", sessionId: s.row.id, state }); } catch (error) { log(error); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<void>((resolve) => { s.finish = resolve; timer = setTimeout(resolve, options.finalizationMs ?? 15_000); });
      try {
        if (s.confirmed || !s.row.provider_id) s.finish?.();
        if (s.row.provider_id && !s.confirmed) await platform.close(s.row.provider_id);
        await done; // Platform owns settlement; absence of session.closed is NOT exact zero usage.
      } catch (error) { log(error); await done; }
      finally {
        clearTimeout(timer); s.finish = undefined;
        try { await repo.update(s.row.id, { state, ended_at: new Date(), answer: null, finalization_confirmed: s.confirmed }); }
        finally { dispose(s); }
      }
    })();
    return s.closing;
  }
  function delivery(s: Live, signal = s.abort.signal): AoedeSessionContext {
    return { principal: s.principal, sessionId: s.row.id, signal,
      append: (kind, content, id) => signal.aborted ? Promise.reject(new AoedeSessionError(409)) : append(s, kind, content, id),
      emit: (message) => { if (active(s) && !signal.aborted) emit(s, message); } };
  }
  async function dispatch(s: Live, delegationId: string, offset: number) {
    if (!active(s) || !options.dispatch || s.inFlight >= 16) return;
    s.inFlight++;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const dispatchAbort = new AbortController();
    const signal = AbortSignal.any([s.abort.signal, dispatchAbort.signal]);
    let claimed = false;
    try {
      await flush(s); const claim = await repo.claim(s.row.id, delegationId);
      if (!claim || !active(s)) return;
      claimed = true;
      await Promise.race([options.dispatch({ ...delivery(s, signal), delegationId, requestId: claim.request_id,
        transcripts: s.buffer.snapshot(offset),
        ui: async (phase, action, target) => {
          if (!s.connectionId || signal.aborted) throw new AoedeSessionError(409);
          // Resolve is advisory; parent must validate installed registry before execute.
          const id = randomUUID();
          return await pending(s, id, phase, () => emit(s, { type: "aoede:ui", sessionId: s.row.id,
            correlationId: id, phase, action, target })) as UiResult;
        },
        record: async (result) => {
          await repo.delegationResult(s.row.id, delegationId, result);
        },
      }), new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => { dispatchAbort.abort(); reject(new AoedeSessionError()); }, 30_000);
      })]);
      await repo.delegationResult(s.row.id, delegationId, { state: "done" });
    } catch (error) {
      log(error);
      if (claimed) await repo.delegationResult(s.row.id, delegationId, { state: "uncertain" });
    } finally { clearTimeout(deadline); s.inFlight--; }
  }
  function event(s: Live, raw: unknown) {
    if (s.ended || !raw || typeof raw !== "object") return;
    const e = raw as Record<string, unknown>;
    if (e.type === "session.closed") {
      const parsed = z.object({ session: z.object({ id: Id }) }).safeParse(e);
      if (parsed.success && parsed.data.session.id === s.row.provider_id) {
        s.confirmed = true;
        if (s.finish) s.finish(); else void closeLive(s).catch(log);
      }
      return;
    }
    if (!active(s) && (s.row.state !== "connecting" || s.closing || stopped)) return;
    if (e.type === "error") {
      const parsed = z.object({ error: z.object({ client_event_id: Id.optional(), param: z.string().max(160).optional(),
        type: z.string().max(160).optional(), code: z.string().max(160).optional() }), client_event_id: Id.optional() }).safeParse(e);
      if (parsed.success) {
        const id = parsed.data.error.client_event_id ?? parsed.data.client_event_id;
        const p = id && s.pending.get(id);
        if (p && id) {
          const rejection = parsed.data.error;
          clearTimeout(p.timer); s.pending.delete(id);
          p.reject(rejection.param === "delegation_id" && rejection.type === "invalid_request_error"
            && rejection.code !== "unknown_parameter" ? new DelegationRejected() : new AoedeSessionError());
        }
      }
    } else if (typeof e.client_event_id === "string") {
      const p = s.pending.get(e.client_event_id);
      if (p && p.expected === e.type) { clearTimeout(p.timer); s.pending.delete(e.client_event_id); p.resolve(); }
    }
    if (e.type === "session.input_transcript.delta" || e.type === "session.output_transcript.delta") {
      const d = Delta.safeParse(e); if (!d.success || d.data.end_ms < d.data.start_ms) return;
      s.buffer.add(e.type === "session.input_transcript.delta" ? "user" : "assistant", d.data.delta, d.data.end_ms, d.data.event_id);
      if (!s.checkpoint) s.checkpoint = setTimeout(() => {
        s.checkpoint = undefined; void tracked(s, () => flush(s));
      }, 250);
    } else if (e.type === "session.delegation.created" && options.dispatch && active(s)) {
      const d = Delegation.safeParse(e); if (!d.success || s.grace.size >= 16 || s.grace.has(d.data.delegation.id)) return;
      const id = d.data.delegation.id;
      s.grace.set(id, setTimeout(() => {
        s.grace.delete(id); void dispatch(s, id, d.data.offset_ms).catch(log);
      }, Math.min(1_000, Math.max(0, options.graceMs ?? 300))));
    } else if (e.type === "session.started" || e.type === "session.updated") {
      const p = z.object({ session: z.object({ id: Id, expires_at: z.number().positive().optional() }) }).safeParse(e);
      if (p.success && p.data.session.id === s.row.provider_id && p.data.session.expires_at) {
        const expiry = new Date(p.data.session.expires_at * 1_000);
        s.row.expires_at = expiry;
        void tracked(s, () => repo.update(s.row.id, { expires_at: expiry }).then(() => {}));
        clearTimeout(s.cap); s.cap = setTimeout(() => { void closeLive(s).catch(log); },
          Math.max(0, Math.min(expiry.getTime() - Date.now(), s.row.started_at.getTime() + durationMs - Date.now())));
      }
    }
  }
  function makeLive(row: SessionRecord, principal: RequestPrincipal, seed: AoedeTranscript[] = []): Live {
    if (live.size >= 4) throw new AoedeSessionError(429);
    const s: Live = { row, principal, greeted: false, ended: false, confirmed: row.finalization_confirmed ?? false,
      inFlight: 0, pending: new Map(), grace: new Map(),
      abort: new AbortController(), buffer: createTranscriptBuffer(seed), work: Promise.resolve(), queuedWrites: 0 };
    live.set(row.id, s); return s;
  }
  const service = {
    recover() {
      return recovery ??= (async () => {
        await repo.expireRecovery();
        for (const row of await repo.interrupt()) {
          const s = makeLive(row, { userId: repo.ownerId, source: "configured-container" }, row.checkpoint);
          try { if (row.provider_id) s.socket = await platform.attach(row.provider_id, (e) => event(s, e), () => s.finish?.()); }
          catch (error) { log(error); }
          await closeLive(s, "interrupted"); // Attach is only for cleanup, never replay or action dispatch.
        }
      })();
    },
    async start(principal: RequestPrincipal, raw: unknown): Promise<AoedeSessionResponse> {
      auth(principal); const input = AoedeStartRequestSchema.parse(raw);
      if (stopped || starts >= 4) throw new AoedeSessionError(429);
      starts++;
      const result = tail.then(async () => {
        await service.recover(); if (stopped) throw new AoedeSessionError();
        for (const current of live.values()) if (active(current)) await flush(current);
        const prior = await repo.latest();
        const reserved = await repo.reserve(input.clientRequestId, createHash("sha256").update(input.sdp).digest("hex"));
        const row = reserved.record;
        if (!reserved.created) {
          if (row.state !== "active" || !row.answer || !row.provider_id || !live.has(row.id)) throw new AoedeConflictError();
          return { sessionId: row.id, providerSessionId: row.provider_id, sdp: row.answer };
        }
        if (reserved.superseded) {
          const old = live.get(reserved.superseded.id) ?? makeLive(reserved.superseded, principal);
          await closeLive(old, "superseded");
        }
        const s = makeLive(row, principal, prior?.checkpoint_until && prior.checkpoint_until.getTime() > Date.now() ? prior.checkpoint : []);
        s.previousSessionId = prior?.id;
        try {
          const minted = await platform.mint({ ...input, instructions: buildAoedePrompt(await options.facts?.()),
            input: s.buffer.startup() });
          row.provider_id = minted.providerSessionId;
          // Persist binding even if a competing process has superseded this invocation; compensate below.
          await repo.update(row.id, { provider_id: row.provider_id });
          s.socket = await platform.attach(row.provider_id, (e) => event(s, e), () => {
            if (!s.ended) void closeLive(s, "interrupted").catch(log);
          });
          if (s.closing || stopped) throw new AoedeConflictError();
          if (!await repo.update(row.id, { state: "active", answer: minted.sdp }, "connecting")) throw new AoedeConflictError();
          row.state = "active";
          await flush(s);
          clearTimeout(s.cap);
          s.cap = setTimeout(() => { void closeLive(s).catch(log); }, Math.max(0, Math.min(
            durationMs, (row.expires_at?.getTime() ?? Infinity) - Date.now())));
          return { sessionId: row.id, ...minted };
        } catch (error) {
          log(error); await closeLive(s, "interrupted"); throw new AoedeSessionError();
        }
      });
      tail = result.then(() => {}, () => {});
      try { return await result; } finally { starts--; }
    },
    async close(principal: RequestPrincipal, sessionId: string) {
      auth(principal); z.uuid().parse(sessionId);
      return exclusive(async () => {
        const row = await repo.get(sessionId); if (!row) throw new AoedeSessionError(404);
        const s = live.get(sessionId);
        if (s) await closeLive(s);
        else if (["active", "connecting", "closing"].includes(row.state)) await closeLive(makeLive(row, principal, row.checkpoint));
      });
    },
    async snapshot(principal: RequestPrincipal) {
      auth(principal); await repo.expireRecovery(); const row = await repo.latest();
      return { session: row ? { id: row.id, state: row.state, providerSessionId: row.provider_id, chatId: row.chat_id,
        startedAt: row.started_at, endedAt: row.ended_at, expiresAt: row.expires_at, finalizationConfirmed: row.finalization_confirmed } : null,
        recovery: row?.checkpoint ?? [], delegations: row ? await repo.delegations(row.id) : [],
        warning: "Recent speech may be missing. Start a fresh session; uncertain actions are not replayed." };
    },
    async clearRecovery(principal: RequestPrincipal) {
      auth(principal);
      return exclusive(async () => {
        for (const s of live.values()) s.buffer.clear();
        for (const row of await repo.clearRecovery()) {
          const s = live.get(row.id); if (s) s.row.checkpoint_epoch = row.checkpoint_epoch;
        }
      });
    },
    async onClientMessage(principal: RequestPrincipal, connectionId: string, raw: unknown) {
      auth(principal); const frame = AoedeClientMessageSchema.parse(raw);
      const s = live.get(frame.sessionId); if (!s || !active(s) || !connectionId || connectionId.length > 256) return;
      if (frame.type === "aoede:ready" && !s.connectionId) s.connectionId = connectionId;
      if (s.connectionId !== connectionId) return;
      if (frame.type === "aoede:ready") {
        if (s.greeted) return; s.greeted = true;
        try {
          await append(s, "instructions", AOEDE_GREETING, null);
          await options.onReady?.(delivery(s), s.previousSessionId);
          emit(s, { type: "aoede:state", sessionId: s.row.id, state: "active" });
        }
        catch (error) { log(error); emit(s, { type: "aoede:state", sessionId: s.row.id, state: "error" }); }
      } else if (frame.type === "aoede:ui_result") {
        const p = s.pending.get(frame.correlationId);
        if (p?.expected === frame.phase) { clearTimeout(p.timer); s.pending.delete(frame.correlationId); p.resolve(frame); }
      } else await options.onBoundClientMessage?.(principal, connectionId, frame);
    },
    async shutdown() {
      stopped = true; clearInterval(expirySweep); await recovery; await tail;
      await Promise.all([...live.values()].map((s) => closeLive(s, "interrupted")));
    },
  };
  return service;
}
export type AoedeSessionService = ReturnType<typeof createAoedeSessionService>;
