/**
 * Voice session engine (Layer 4).
 *
 * Owns the capped session registry (bounded size, terminal-first LRU
 * eviction), session lifecycle (create → connecting → active → reconnecting
 * → ended/failed), transport epochs (latest committed credential generation
 * wins, predecessors fenced), one-time ticket issuance, heartbeat/idle/
 * duration limits, idempotent ending, and full shutdown drain.
 *
 * Transport sockets attach through `attachTransport`; per-session frame
 * semantics live in `session-runtime.ts`/`session-pipeline.ts`. Canonical
 * admission, delivery, run control and run events arrive through the narrow
 * ports in `ports.ts` — the engine never touches canonical state directly.
 */
import { randomUUID } from "node:crypto";
import type { CanonicalChatModelSelection } from "@matrix-os/contracts";
import {
  VOICE_SESSION_LIMITS,
  type SafeVoiceErrorCode,
  type VoiceSessionLimits,
  type VoiceSessionState,
  type VoiceTurnMode,
} from "@matrix-os/contracts/voice-session";
import type { RequestPrincipal } from "../request-principal.js";
import type { VoiceMediaAdapterRegistry } from "./adapter.js";
import type {
  VoiceAdmissionPort,
  VoiceChatEventSource,
  VoiceClock,
  VoiceDeliveryPort,
  VoiceMemoryMode,
  VoiceRunControlPort,
} from "./ports.js";
import { createSystemVoiceClock } from "./ports.js";
import {
  ACTIVE_SESSION_STATES,
  enqueueSessionTask,
  VoiceSessionRuntime,
  type VoiceSessionEndKind,
  type VoiceSessionHost,
  type VoiceSessionRecord,
  type VoiceTransportBinding,
} from "./session-runtime.js";
import type { VoiceTicketAuthority } from "./ticket-auth.js";
import type {
  ActiveVoiceSessionPolicy,
  VoiceSessionPolicyLookup,
} from "../chat/voice-session-policy.js";

export type VoiceSessionErrorCode =
  | SafeVoiceErrorCode
  | "not_found"
  | "unauthorized"
  | "invalid_request"
  | "payload_too_large"
  | "rate_limited"
  | "unavailable";

export class VoiceSessionError extends Error {
  constructor(
    readonly code: VoiceSessionErrorCode,
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "VoiceSessionError";
  }
}

export interface VoiceSessionCreateInput {
  clientRequestId: string;
  turnMode: VoiceTurnMode;
  memoryMode: VoiceMemoryMode;
  requestedTransport?: "relayed_websocket" | "direct_webrtc";
  selection: CanonicalChatModelSelection;
  interactionMode: string;
  permissionMode: string;
  locale?: string;
}

export interface VoiceTransportLeaseInfo {
  kind: "relayed_websocket";
  path: string;
  ticket: string;
  expiresAt: string;
  epoch: number;
}

export interface VoiceSessionSummary {
  sessionId: string;
  chatId: string;
  status: VoiceSessionState;
  epoch: number;
  reconnectAttempts: number;
  createdAt: string;
  limits: {
    maxSessionSeconds: number;
    maxIdleSeconds: number;
    maxQueuedAudioMs: number;
  };
}

export type VoiceSessionCreateOutcome =
  | { outcome: "created" | "rotated_unconsumed"; session: VoiceSessionSummary; lease: VoiceTransportLeaseInfo }
  | { outcome: "existing_consumed"; session: VoiceSessionSummary };

export interface VoiceSessionReconnectOutcome {
  session: VoiceSessionSummary;
  lease: VoiceTransportLeaseInfo;
}

export interface VoiceSessionEndOutcome {
  session: VoiceSessionSummary;
  alreadyTerminal: boolean;
}

export interface VoiceSessionTransportHandle {
  readonly sessionId: string;
  readonly epoch: number;
  /** Enqueues the frame behind the session mutation queue; resolves after dispatch. */
  receive(frame: Parameters<VoiceSessionRuntime["receiveFrame"]>[1]): Promise<void>;
  transportClosed(): void;
  close(): void;
}

export interface VoiceSessionEngineDeps {
  admission: VoiceAdmissionPort;
  delivery: VoiceDeliveryPort;
  chatEvents: VoiceChatEventSource;
  runControl?: VoiceRunControlPort;
  adapters: VoiceMediaAdapterRegistry;
  tickets: VoiceTicketAuthority;
  clock?: VoiceClock;
  limits?: Partial<VoiceSessionLimits>;
  /** Registry cap; terminal sessions are evicted before any active denial. */
  maxSessions?: number;
  maxTurns?: number;
  maxResponses?: number;
  maxRunIds?: number;
  /** Adapter selection is server policy; defaults to the registry default. */
  selectAdapter?: (input: { principalId: string; chatId: string }) => string;
  /** Exact WS path a ticket binds to; must match the mounted route. */
  transportPath?: (chatId: string, sessionId: string) => string;
  createId?: (prefix: string) => string;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const TERMINAL_STATES: ReadonlySet<VoiceSessionState> = new Set(["ended", "failed"]);

function defaultTransportPath(chatId: string, sessionId: string): string {
  return `/ws/chats/${chatId}/voice/${sessionId}`;
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function defaultLog(event: string, fields: Record<string, unknown>): void {
  console.warn(`[voice-session] ${event}`, fields);
}

function fingerprint(input: VoiceSessionCreateInput): string {
  return JSON.stringify({
    turnMode: input.turnMode,
    memoryMode: input.memoryMode,
    requestedTransport: input.requestedTransport ?? null,
    selection: input.selection,
    interactionMode: input.interactionMode,
    permissionMode: input.permissionMode,
    locale: input.locale ?? null,
  });
}

export class VoiceSessionEngine implements VoiceSessionHost {
  readonly limits: VoiceSessionLimits;
  readonly clock: VoiceClock;
  readonly admission: VoiceAdmissionPort;
  readonly delivery: VoiceDeliveryPort;
  readonly runControl?: VoiceRunControlPort;
  readonly adapters: VoiceMediaAdapterRegistry;
  readonly maxTurns: number;
  readonly maxResponses: number;
  readonly maxRunIds: number;

  private readonly deps: VoiceSessionEngineDeps;
  private readonly sessions = new Map<string, VoiceSessionRecord>();
  private readonly requestIndex = new Map<string, string>();
  private readonly maxSessions: number;
  private closed = false;

  /**
   * Canonical admission hook: exposes the immutable policy of whichever live
   * session currently owns a Chat, so typed/queued/steered/retried turns
   * cannot bypass the session's run policy while it is active. The server
   * registers this provider with `createVoiceSessionPolicyLookup`.
   */
  readonly sessionPolicyLookup: VoiceSessionPolicyLookup = {
    policyForChat: (chatId) => {
      for (const session of this.sessions.values()) {
        if (session.chatId === chatId && ACTIVE_SESSION_STATES.has(session.state)) {
          const policy: ActiveVoiceSessionPolicy = {
            sessionId: session.sessionId,
            memoryMode: session.memoryMode,
            permissionMode: session.permissionMode,
          };
          return policy;
        }
      }
      return undefined;
    },
  };

  constructor(deps: VoiceSessionEngineDeps) {
    this.deps = deps;
    this.limits = { ...VOICE_SESSION_LIMITS, ...deps.limits };
    this.clock = deps.clock ?? createSystemVoiceClock();
    this.admission = deps.admission;
    this.delivery = deps.delivery;
    this.adapters = deps.adapters;
    this.maxSessions = deps.maxSessions ?? 64;
    this.maxTurns = deps.maxTurns ?? 256;
    this.maxResponses = deps.maxResponses ?? 64;
    this.maxRunIds = deps.maxRunIds ?? 128;
    if (deps.runControl) this.runControl = deps.runControl;
  }

  createId(prefix: string): string {
    return (this.deps.createId ?? defaultCreateId)(prefix);
  }

  log(event: string, fields: Record<string, unknown>): void {
    (this.deps.log ?? defaultLog)(event, fields);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new VoiceSessionError("unavailable", "Voice session engine is closed", 503);
    }
  }

  private requestKey(principalId: string, chatId: string, clientRequestId: string): string {
    return `${principalId}\u0000${chatId}\u0000${clientRequestId}`;
  }

  private isTerminal(session: VoiceSessionRecord): boolean {
    return TERMINAL_STATES.has(session.state);
  }

  touch(session: VoiceSessionRecord): void {
    if (this.isTerminal(session)) return;
    session.lastActivityAtMs = this.clock.now();
    this.armIdleTimer(session);
  }

  // ------------------------------------------------------------------ create

  createSession(input: {
    principal: RequestPrincipal;
    chatId: string;
    request: VoiceSessionCreateInput;
  }): VoiceSessionCreateOutcome {
    this.assertOpen();
    const { principal, chatId, request } = input;
    const existingId = this.requestIndex.get(
      this.requestKey(principal.userId, chatId, request.clientRequestId),
    );
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing) return this.retryCreate(existing, request);
    }
    this.assertSessionCapacity();
    this.assertNoActiveConflict(principal.userId, chatId);

    const adapter = this.selectAdapter(principal.userId, chatId);
    if (!adapter) {
      throw new VoiceSessionError("provider_unavailable", "No voice adapter is configured", 503);
    }
    const caps = adapter.capabilities;
    if (request.memoryMode === "session_only" && caps.sessionOnly !== "enforced") {
      throw new VoiceSessionError("unsupported_surface", "Session-only mode is not supported", 422);
    }
    if (request.requestedTransport === "direct_webrtc" || !caps.transportModes.includes("relayed_websocket")) {
      throw new VoiceSessionError("unsupported_surface", "Requested transport is not supported", 422);
    }
    if (!caps.turnModes.includes(request.turnMode)) {
      throw new VoiceSessionError("unsupported_surface", "Requested turn mode is not supported", 422);
    }

    const now = this.clock.now();
    const sessionId = this.createId("vs");
    const record: VoiceSessionRecord = {
      sessionId,
      chatId,
      principalId: principal.userId,
      principalSource: principal.source,
      clientRequestId: request.clientRequestId,
      fingerprint: fingerprint(request),
      state: "connecting",
      restorableState: "listening",
      epoch: 0,
      credentialGeneration: 0,
      reconnectAttempts: 0,
      leaseConsumed: false,
      turnMode: request.turnMode,
      memoryMode: request.memoryMode,
      selection: request.selection,
      interactionMode: request.interactionMode,
      permissionMode: request.permissionMode,
      ...(request.locale !== undefined ? { locale: request.locale } : {}),
      ...(request.requestedTransport !== undefined ? { requestedTransport: request.requestedTransport } : {}),
      adapterId: adapter.id,
      adapter: null,
      turns: new Map(),
      finalityToTurn: new Map(),
      stagedFinals: new Map(),
      nextAdmissionOrder: 1,
      responses: new Map(),
      runIds: new Set(),
      terminalRunIds: new Set(),
      turnOrderCounter: 0,
      lastKnownChatRevision: 0,
      chatRevisionLoaded: false,
      transport: null,
      chatSubscription: null,
      timers: { idle: null, duration: null, staging: null },
      queuedAudioMs: 0,
      activeCaptureTurnId: null,
      createdAtMs: now,
      lastActivityAtMs: now,
      endedAtMs: null,
      endKind: null,
      ending: null,
      mutation: Promise.resolve(),
      inTask: false,
      staleFrameCount: 0,
      runtime: undefined as unknown as VoiceSessionRuntime,
    };
    record.runtime = new VoiceSessionRuntime(record, this);
    try {
      record.chatSubscription = this.deps.chatEvents.subscribe(
        { chatId, principalId: principal.userId },
        (event) => record.runtime.pipeline.onCanonicalEvent(event),
      );
    } catch (error: unknown) {
      this.log("voice.subscription.open_failed", {
        sessionId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      // Preserve honest codes (e.g. session_limit_reached from the subscriber
      // cap) instead of masking them as internal_failure.
      throw error instanceof VoiceSessionError
        ? error
        : new VoiceSessionError("internal_failure", "Voice session could not start", 500);
    }
    this.sessions.set(sessionId, record);
    this.requestIndex.set(this.requestKey(principal.userId, chatId, request.clientRequestId), sessionId);
    this.armTimers(record);
    return { outcome: "created", session: this.summarize(record), lease: this.mintLease(record) };
  }

  /**
   * Lost-create-response handling: same principal/chat/clientRequestId with
   * identical semantics preserves the session, rotates the unconsumed
   * credential, and returns only the new ticket. A consumed lease returns
   * status without credentials (`existing_consumed`); diverging semantics
   * are rejected.
   */
  private retryCreate(
    session: VoiceSessionRecord,
    request: VoiceSessionCreateInput,
  ): VoiceSessionCreateOutcome {
    if (session.fingerprint !== fingerprint(request)) {
      throw new VoiceSessionError("session_conflict", "Session request does not match", 409);
    }
    const ticketState = this.deps.tickets.describeSession(session.sessionId)?.state;
    const consumed = session.leaseConsumed || ticketState === "consumed";
    if (consumed || this.isTerminal(session)) {
      return { outcome: "existing_consumed", session: this.summarize(session) };
    }
    return {
      outcome: "rotated_unconsumed",
      session: this.summarize(session),
      lease: this.mintLease(session),
    };
  }

  private mintLease(session: VoiceSessionRecord): VoiceTransportLeaseInfo {
    const path = (this.deps.transportPath ?? defaultTransportPath)(session.chatId, session.sessionId);
    session.credentialGeneration += 1;
    const minted = this.deps.tickets.mint({
      principalId: session.principalId,
      chatId: session.chatId,
      sessionId: session.sessionId,
      path,
      generation: session.credentialGeneration,
    });
    // The committed epoch is the latest minted generation; predecessors are
    // superseded inside the ticket store and fenced at attach/frame time.
    session.epoch = minted.generation;
    return {
      kind: "relayed_websocket",
      path,
      ticket: minted.ticket,
      expiresAt: new Date(minted.expiresAtMs).toISOString(),
      epoch: session.epoch,
    };
  }

  private selectAdapter(principalId: string, chatId: string) {
    const id = this.deps.selectAdapter?.({ principalId, chatId });
    return id ? this.adapters.get(id) : this.adapters.default();
  }

  private assertSessionCapacity(): void {
    if (this.sessions.size < this.maxSessions) return;
    // Terminal-first LRU eviction; never drop an active session silently.
    const terminal = [...this.sessions.values()]
      .filter((session) => this.isTerminal(session))
      .sort((a, b) => a.lastActivityAtMs - b.lastActivityAtMs);
    for (const session of terminal) {
      this.sessions.delete(session.sessionId);
      this.requestIndex.delete(
        this.requestKey(session.principalId, session.chatId, session.clientRequestId),
      );
      if (this.sessions.size < this.maxSessions) return;
    }
    throw new VoiceSessionError("session_limit_reached", "Voice session limit reached", 429);
  }

  private assertNoActiveConflict(principalId: string, chatId: string): void {
    for (const session of this.sessions.values()) {
      if (session.principalId === principalId
        && session.chatId === chatId
        && !this.isTerminal(session)) {
        throw new VoiceSessionError("session_conflict", "Chat already has an active voice session", 409);
      }
    }
  }

  // --------------------------------------------------------------- reconnect

  reconnectSession(input: {
    principal: RequestPrincipal;
    chatId: string;
    sessionId: string;
    clientRequestId?: string;
  }): VoiceSessionReconnectOutcome {
    this.assertOpen();
    const session = this.requireOwnedSession(input);
    if (session.state === "ending" || session.state === "ended") {
      throw new VoiceSessionError("session_conflict", "Session has ended", 409);
    }
    if (session.reconnectAttempts >= this.limits.maxReconnectAttempts) {
      throw new VoiceSessionError("session_limit_reached", "Reconnect limit reached", 429);
    }
    session.reconnectAttempts += 1;
    const lease = this.mintLease(session);
    // The new committed epoch fences the previous transport immediately.
    session.runtime.closeTransportGracefully("Epoch rotated", true);
    if (session.state === "failed") {
      // Explicit retry is the only way out of failed; the end path already
      // released adapter + subscription, so restore both before continuing.
      session.state = "connecting";
      session.restorableState = "listening";
      session.endedAtMs = null;
      session.endKind = null;
      session.ending = null;
      if (!session.chatSubscription) {
        try {
          session.chatSubscription = this.deps.chatEvents.subscribe(
            { chatId: session.chatId, principalId: session.principalId },
            (event) => session.runtime.pipeline.onCanonicalEvent(event),
          );
        } catch (error: unknown) {
          this.log("voice.subscription.open_failed", {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.name : "UnknownError",
          });
          throw new VoiceSessionError("internal_failure", "Voice session could not restart", 500);
        }
      }
      this.armTimers(session);
    } else if (session.state !== "connecting") {
      session.restorableState = session.runtime.resumeTarget();
      session.state = "reconnecting";
    }
    return { session: this.summarize(session), lease };
  }

  describeSession(input: {
    principal: RequestPrincipal;
    chatId: string;
    sessionId: string;
  }): VoiceSessionSummary | null {
    const session = this.sessions.get(input.sessionId);
    if (!session
      || session.principalId !== input.principal.userId
      || session.chatId !== input.chatId) {
      return null;
    }
    return this.summarize(session);
  }

  // --------------------------------------------------------------------- end

  endSession(input: {
    principal: RequestPrincipal;
    chatId: string;
    sessionId: string;
    kind?: VoiceSessionEndKind;
  }): Promise<VoiceSessionEndOutcome> {
    const session = this.requireOwnedSession(input);
    const alreadyTerminal = this.isTerminal(session);
    return this.finish(session, input.kind ?? "user").then(() => ({
      session: this.summarize(session),
      alreadyTerminal,
    }));
  }

  /**
   * Idempotent ending: serialized on the session mutation queue so DELETE,
   * provider shutdown, and transport close can race safely. When called from
   * inside the queue (adapter fatal, limit timers, `session.end`) the end
   * runs inline — re-enqueueing behind the running task would deadlock.
   */
  finish(session: VoiceSessionRecord, kind: VoiceSessionEndKind): Promise<void> {
    if (this.isTerminal(session)) return Promise.resolve();
    session.ending ??= (
      session.inTask
        ? session.runtime.end(kind)
        : enqueueSessionTask(session, () => session.runtime.end(kind))
    ).then(
      () => {
        this.afterTerminal(session);
      },
      (error: unknown) => {
        // Terminal cleanup failures are logged; a later finish may retry.
        this.log("voice.session.end_failed", {
          sessionId: session.sessionId,
          error: error instanceof Error ? error.name : "UnknownError",
        });
        session.ending = null;
        this.afterTerminal(session);
      },
    );
    return session.ending;
  }

  private afterTerminal(session: VoiceSessionRecord): void {
    session.timers.idle?.cancel();
    session.timers.duration?.cancel();
    session.timers.staging?.cancel();
    session.timers.idle = null;
    session.timers.duration = null;
    session.timers.staging = null;
    this.deps.tickets.revokeSession(session.sessionId);
  }

  // ------------------------------------------------------------------- timers

  private armTimers(session: VoiceSessionRecord): void {
    this.armIdleTimer(session);
    this.armDurationTimer(session);
  }

  /**
   * The duration limit is an absolute deadline (`createdAt + maxSessionSeconds`).
   * Re-arming after a failed→retry reconnect computes only the
   * remaining time — retries must never extend the session's lifespan.
   */
  private armDurationTimer(session: VoiceSessionRecord): void {
    session.timers.duration?.cancel();
    const deadlineMs = session.createdAtMs + this.limits.maxSessionSeconds * 1_000;
    const remainingMs = Math.max(0, deadlineMs - this.clock.now());
    session.timers.duration = this.clock.after(remainingMs, () => {
      this.limitReached(session, "duration_limit");
    });
  }

  private armIdleTimer(session: VoiceSessionRecord): void {
    session.timers.idle?.cancel();
    session.timers.idle = this.clock.after(this.limits.maxIdleSeconds * 1_000, () => {
      this.limitReached(session, "idle_limit");
    });
  }

  private limitReached(session: VoiceSessionRecord, kind: "idle_limit" | "duration_limit"): void {
    if (this.isTerminal(session)) return;
    this.log("voice.session.limit", { sessionId: session.sessionId, kind });
    void enqueueSessionTask(session, async () => {
      session.runtime.emitError("session_limit_reached", false);
      await this.finish(session, kind);
    });
  }

  // --------------------------------------------------------------- transport

  /**
   * Attach a socket after the ticket has been verified + consumed. Epoch and
   * principal/chat/session binding are revalidated here — the only transport
   * allowed to mutate the session is the latest committed generation.
   */
  attachTransport(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    generation: number;
  }, sink: VoiceTransportBinding["sink"]): VoiceSessionTransportHandle {
    const session = this.sessions.get(input.sessionId);
    if (!session
      || session.chatId !== input.chatId
      || session.principalId !== input.principalId) {
      throw new VoiceSessionError("unauthorized", "Transport binding mismatch", 401);
    }
    if (this.isTerminal(session)) {
      throw new VoiceSessionError("session_conflict", "Session has ended", 409);
    }
    if (input.generation !== session.credentialGeneration || input.generation !== session.epoch) {
      throw new VoiceSessionError("session_conflict", "Stale transport generation", 409);
    }
    session.leaseConsumed = true;
    const binding: VoiceTransportBinding = {
      epoch: input.generation,
      lastInboundSequence: -1,
      nextOutboundSequence: 0,
      closed: false,
      sink,
    };
    session.runtime.attachTransport(binding);
    // A fresh transport counts as activity — the idle clock restarts here.
    this.touch(session);
    const runtime = session.runtime;
    return {
      sessionId: session.sessionId,
      epoch: binding.epoch,
      receive: (frame) => runtime.receiveFrame(binding, frame),
      transportClosed: () => runtime.detachTransport(binding),
      close: () => runtime.detachTransport(binding),
    };
  }

  // ---------------------------------------------------------------- summary

  private requireOwnedSession(input: {
    principal: RequestPrincipal;
    chatId: string;
    sessionId: string;
  }): VoiceSessionRecord {
    const session = this.sessions.get(input.sessionId);
    // Unknown or foreign sessions share one not-found: no existence leaks.
    if (!session
      || session.principalId !== input.principal.userId
      || session.chatId !== input.chatId) {
      throw new VoiceSessionError("not_found", "Voice session not found", 404);
    }
    return session;
  }

  private summarize(session: VoiceSessionRecord): VoiceSessionSummary {
    return {
      sessionId: session.sessionId,
      chatId: session.chatId,
      status: session.state,
      epoch: session.epoch,
      reconnectAttempts: session.reconnectAttempts,
      createdAt: new Date(session.createdAtMs).toISOString(),
      limits: {
        maxSessionSeconds: this.limits.maxSessionSeconds,
        maxIdleSeconds: this.limits.maxIdleSeconds,
        maxQueuedAudioMs: this.limits.maxQueuedAudioMs,
      },
    };
  }

  // --------------------------------------------------------------- shutdown

  get size(): number {
    return this.sessions.size;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Test/observability seam: resolves when the session mutation queue is idle. */
  async drain(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.mutation;
  }

  /**
   * Drain: stop admission, end every session (going_away + terminal state),
   * release adapters/subscriptions/timers, then revoke all tickets. Engine
   * dependencies (canonical/runtime) close afterwards in existing order.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(
      sessions.map((session) => this.finish(session, "shutdown")),
    );
    for (const session of sessions) {
      session.timers.idle?.cancel();
      session.timers.duration?.cancel();
    }
    this.deps.tickets.clear();
  }
}
