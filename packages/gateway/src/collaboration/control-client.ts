/**
 * Control client (S05 / T027, T028).
 *
 * Registers this home with the platform by its enrollment identity, learns
 * the platform ticket verification keys and a one-use control ticket, then
 * holds the control stream: pushed denials end matching direct sessions,
 * end the actor's grants and activations, evict cached membership evidence
 * and are acknowledged with a fence; generation frames move this home's
 * authority generation and, as the platform's keepalive, are acknowledged
 * with the unchanged fence so the platform reads the home as live.
 * Reconnects with bounded, jittered backoff that resets only once a stream has
 * proven healthy: it applied an inbound frame and stayed open for
 * HEALTHY_STREAM_MIN_MS. A proven stream the platform closes (routine rotation or
 * drain) reconnects after a short jittered delay; a short-lived stream, or one the
 * client terminated itself, is a failure and backs off. A registration Retry-After
 * on 429/503 floors the next attempt, spread by a bounded jitter. Control snapshots
 * have fixed expiry and are extended only by an inbound frame, never by a reconnect.
 */
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationControlAssertionSchema,
  toLogicalRuntimeId,
  type CollaborationControlAck,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { type DirectSigningKey } from "./direct-auth.js";
import type { DirectSessionService } from "./direct-sessions.js";
import type { CollaborationCapabilityRepository } from "./capability-repository.js";
import { requireSecureCollaborationPlatformBaseUrl } from "./platform-base-url.js";

/** Fence a home reports before it has applied any denial: asserts nothing. */
const NO_FENCE_AT = "1970-01-01T00:00:00.000Z";

/** Membership source that can drop cached evidence for a denied actor or organization. */
export interface MembershipEvidenceEvictor {
  evict(input: { organizationId: string; actorId?: string }): void;
}

export function isMembershipEvidenceEvictor(source: object): source is MembershipEvidenceEvictor {
  return typeof (source as Partial<MembershipEvidenceEvictor>).evict === "function";
}

const RegistrationResponseSchema = z.object({
  protocolVersion: z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION),
  runtime: z.object({ runtimeId: z.string(), authorityGeneration: z.number().int().positive(), registeredAt: z.string() }).strict(),
  platformSigningKeys: z.array(z.object({ keyId: z.string().min(1).max(80), algorithm: z.literal("ed25519"), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()).max(8),
  controlTicket: z.string().min(43).max(256).regex(/^[A-Za-z0-9_-]+$/),
  relay: z.object({ origin: z.string().url() }).strict(),
}).strict();

export type RegistrationResponse = z.infer<typeof RegistrationResponseSchema>;

export interface ControlSocketLike {
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export interface ControlStreamHandle {
  receive(raw: string): Promise<void>;
  close(): void;
}

const REGISTRATION_TIMEOUT_MS = COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs;
/**
 * Control frames awaiting ordered application on one stream. A deeper backlog means this home
 * cannot keep up with the platform, so the stream is torn down and re-registered rather than
 * acknowledging stale frames late; unacknowledged denials are redelivered after the reconnect.
 */
const MAX_PENDING_CONTROL_FRAMES = 128;
const CONTROL_SNAPSHOT_TTL_MS = COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds * 1_000;
const REREGISTER_INTERVAL_MS = 5 * 60_000;
/** Re-registration runs every interval x [0.8, 1.2] so homes started together drift apart. */
const REREGISTER_JITTER_RATIO = 0.2;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/**
 * Delay range after a stream that had proven healthy closes. The platform rotates control
 * streams routinely and drains instances, so a whole fleet can lose its streams in the same
 * second; spreading the reconnect over this window keeps them from arriving in lockstep.
 */
const HEALTHY_RECONNECT_MIN_MS = 500;
const HEALTHY_RECONNECT_MAX_MS = 5_000;
/**
 * Minimum lifetime for a closed stream to count as healthy. A stream that applies one frame
 * and is then closed within this window (a redelivered frame this home always refuses, or a
 * platform close right after the first keepalive) is a failure, so such cycles back off
 * exponentially instead of reconnecting every few seconds forever.
 */
const HEALTHY_STREAM_MIN_MS = 30_000;
/** Bounds for a registration Retry-After (delta-seconds) used as the next reconnect floor. */
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 300_000;
/** A Retry-After floor is spread over [floor, floor + min(floor x ratio, MAX_BACKOFF_MS)] so a throttled fleet does not return in lockstep. */
const RETRY_AFTER_JITTER_RATIO = 0.2;

/** Registration refused by the platform with a non-success status; carries only coarse retry hints. */
export class RegistrationRejectedError extends Error {
  override readonly name = "RegistrationRejectedError";
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`Registration rejected (${status})`);
  }
}

/**
 * Parses a Retry-After header in its delta-seconds form, clamped to a sane range. The
 * HTTP-date form and anything malformed are ignored rather than trusted.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,10}$/.test(trimmed)) return undefined;
  const ms = Number(trimmed) * 1_000;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
}

export class CollaborationControlClient {
  static readonly MAX_PENDING_CONTROL_FRAMES = MAX_PENDING_CONTROL_FRAMES;
  private keys: DirectSigningKey[] = [];
  private generation = 1;
  private snapshotExpiresAt = 0;
  private closed = false;
  private stream: ControlStreamHandle | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private registerTimer: ReturnType<typeof setTimeout> | undefined;
  /** Exponential base for the next failed-attempt delay; reset only by a stream that proved healthy. */
  private backoffMs = INITIAL_BACKOFF_MS;
  /** One-shot floor from a registration Retry-After, consumed by the next scheduled reconnect. */
  private retryAfterFloorMs: number | undefined;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  /** Time of the last denial this home applied and acknowledged; keepalive acks repeat it. */
  private lastFenceAt = NO_FENCE_AT;

  constructor(private readonly options: {
    platformBaseUrl: string;
    runtimeId: string;
    ownerId: string;
    relayHandle: string;
    serviceToken: string;
    identity: { keyId: string; publicKey: string };
    sessions: Pick<DirectSessionService, "revoke">;
    /** Ends the denied actor's grants and activations (transactional per scope) before the fence is acknowledged. */
    capabilities?: Pick<CollaborationCapabilityRepository, "endActorGrants">;
    /** Drops cached membership evidence for the denied actor or organization. */
    membership?: MembershipEvidenceEvictor;
    fetchImpl?: typeof fetch;
    /** Opens the control WebSocket; production uses `ws` through `loadDefaultConnector`, tests pass a fake. */
    connect?(url: string, headers: Record<string, string>, onMessage: (raw: string) => void, onClose: () => void): ControlSocketLike | Promise<ControlSocketLike>;
    now?: () => Date;
    /** Source of jitter in [0, 1]; defaults to `Math.random`, tests pin it. */
    random?: () => number;
    startTimers?: boolean;
    initialGeneration?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.generation = options.initialGeneration ?? 1;
    // Bearer token and one-use control ticket travel on this origin: https, or http only to loopback.
    const base = requireSecureCollaborationPlatformBaseUrl(options.platformBaseUrl);
    this.endpoint = `${base.origin}/internal/collaboration/runtime-endpoints`;
  }

  platformKeys(): readonly DirectSigningKey[] {
    return this.keys;
  }

  authorityGeneration(): number {
    return this.generation;
  }

  /** True while the last control snapshot is within its fixed lifetime. */
  controlFresh(): boolean {
    return this.snapshotExpiresAt > this.now().getTime();
  }

  async register(): Promise<RegistrationResponse> {
    if (this.closed) throw new Error("Control client is shutting down");
    const body = JSON.stringify({
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      runtimeId: toLogicalRuntimeId(this.options.runtimeId),
      ownerId: this.options.ownerId,
      relayHandle: this.options.relayHandle,
      authorityGeneration: this.generation,
      publicKeys: [{ keyId: this.options.identity.keyId, algorithm: "ed25519", publicKey: this.options.identity.publicKey }],
    });
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...this.runtimeHeaders() },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    });
    if (response.status === 426) throw new Error("upgrade_required");
    if (!response.ok) {
      const throttled = response.status === 429 || response.status === 503;
      throw new RegistrationRejectedError(response.status, throttled ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined);
    }
    const parsed = RegistrationResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.runtime.runtimeId !== toLogicalRuntimeId(this.options.runtimeId)) throw new Error("Registration response is invalid");
    // The fence can land while this request is in flight. A registration that comes back
    // afterwards must not commit: publishing platform keys or refreshing the control snapshot
    // would make a runtime that has stopped serving look registered and control-fresh.
    if (this.closed) throw new Error("Control client is shutting down");
    this.keys = parsed.data.platformSigningKeys;
    this.generation = Math.max(this.generation, parsed.data.runtime.authorityGeneration);
    this.snapshotExpiresAt = this.now().getTime() + CONTROL_SNAPSHOT_TTL_MS;
    return parsed.data;
  }

  async connectControl(controlTicket: string): Promise<ControlStreamHandle> {
    if (this.closed) throw new Error("Control client is shutting down");
    const connect = this.options.connect ?? await loadDefaultConnector();
    const url = `${new URL(this.options.platformBaseUrl).origin.replace(/^http/, "ws")}/internal/collaboration/control?ticket=${controlTicket}`;
    let socket: ControlSocketLike | undefined;
    // Frames are applied strictly in arrival order: an acknowledgement covers every denial fenced
    // at or before it, so a later frame must never be acknowledged while an earlier denial's
    // grant cleanup is still pending.
    let inbound: Promise<void> = Promise.resolve();
    // A failed frame, an overflowing backlog or an explicit close terminates this stream: every frame
    // queued behind that point is dropped, so no denial, fence or acknowledgement is applied after it.
    let terminated = false;
    // A socket object exists before its upgrade completes, so a stream counts as healthy only
    // once it has applied an inbound frame (the platform's keepalives arrive every few seconds)
    // and stayed open for HEALTHY_STREAM_MIN_MS.
    let appliedFrame = false;
    // The client tore the stream down itself (refused frame or backlog overflow): a failure,
    // never a healthy close, however long it ran.
    let selfTerminated = false;
    // The socket's close event has been delivered; a frame finishing after it is from a dead stream.
    let socketClosed = false;
    let openedAt: number | undefined;
    let pending = 0;
    const terminate = (): void => {
      if (terminated) return;
      selfTerminated = true;
      terminated = true;
      handle.close();
    };
    // `run` rejects to the caller (tests observe it); `settled` logs and terminates the stream.
    const refuse = (message: string): { run: Promise<void>; settled: Promise<void> } => {
      const run = Promise.reject(new Error(message));
      const settled = run.catch((error: unknown) => {
        console.warn("[collaboration-control-client] frame refused", error instanceof Error ? error.message : "UnknownError");
      });
      return { run, settled };
    };
    const enqueue = (raw: string): { run: Promise<void>; settled: Promise<void> } => {
      if (terminated) return refuse("Control stream is terminated");
      if (pending >= MAX_PENDING_CONTROL_FRAMES) {
        terminate();
        return refuse("Control frame backlog exceeded");
      }
      pending += 1;
      const run = inbound.then(() => {
        if (terminated) throw new Error("Control stream is terminated");
        return this.applyFrame(raw, () => socket);
      }).then(() => {
        // A frame that completes after its stream ended (e.g. a slow denial cleanup) must not
        // count toward that stream's health once a newer failure sequence is underway.
        if (terminated || socketClosed) return;
        appliedFrame = true;
      }).finally(() => { pending -= 1; });
      const settled = run.catch((error: unknown) => {
        console.warn("[collaboration-control-client] frame rejected", error instanceof Error ? error.name : "UnknownError");
        terminate();
      });
      inbound = settled;
      return { run, settled };
    };
    const handle: ControlStreamHandle = {
      receive: (raw) => enqueue(raw).run,
      close: () => {
        terminated = true;
        socket?.close(1001, "Control client closed");
        if (this.stream === handle) this.stream = undefined;
      },
    };
    socket = await connect(url, this.runtimeHeaders(), (raw) => {
      void enqueue(raw).settled;
    }, () => {
      if (socketClosed) return;
      socketClosed = true;
      if (this.stream === handle) this.stream = undefined;
      const lived = openedAt === undefined ? 0 : this.now().getTime() - openedAt;
      const proven = appliedFrame && lived >= HEALTHY_STREAM_MIN_MS;
      // Only a proven stream resets the backoff, so repeated short-lived streams keep doubling it.
      if (proven) this.backoffMs = INITIAL_BACKOFF_MS;
      this.scheduleReconnect(proven && !selfTerminated ? "healthy_close" : "failure");
    });
    // Adoption is the commit point, and the fence may have landed while the socket was
    // connecting. Close the late arrival instead of installing it: nothing would ever
    // close a stream adopted behind the fence.
    if (this.closed) {
      terminated = true;
      try {
        socket.close(1001, "Control client closed");
      } catch (error: unknown) {
        console.warn("[collaboration-control-client] late socket close failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw new Error("Control client is shutting down");
    }
    this.stream = handle;
    openedAt = this.now().getTime();
    return handle;
  }

  private async applyFrame(raw: string, socket: () => ControlSocketLike | undefined): Promise<void> {
    // A drained client has released the sessions, capabilities and membership handles this
    // frame would touch, so no frame starts after the drain.
    if (this.closed) throw new Error("Control client is shutting down");
    if (Buffer.byteLength(raw) > COLLABORATION_DIRECT_LIMITS.wsFrameBytes) throw new Error("Control frame too large");
    const assertion = CollaborationControlAssertionSchema.parse(JSON.parse(raw) as unknown);
    this.snapshotExpiresAt = this.now().getTime() + CONTROL_SNAPSHOT_TTL_MS;
    if (assertion.type === "denial") {
      const { denial } = assertion;
      this.options.sessions.revoke(denial);
      if (denial.organizationId) {
        this.options.membership?.evict({ organizationId: denial.organizationId, ...(denial.actorId ? { actorId: denial.actorId } : {}) });
      }
      if (denial.generation > this.generation) this.generation = denial.generation;
      if (denial.organizationId && denial.actorId && this.options.capabilities) {
        try {
          await this.options.capabilities.endActorGrants({ organizationId: denial.organizationId, actorId: denial.actorId });
        } catch (error: unknown) {
          // Not fully applied: no fence is acknowledged, so the denial completes only at its lease
          // deadline; access is already closed because the evidence was evicted and sessions ended.
          console.warn("[collaboration-control-client] departure grant cleanup failed", error instanceof Error ? error.name : "UnknownError");
          return;
        }
        // The drain may have landed while the cleanup was in flight. The runtime has stopped
        // serving, so the denial is left to complete at its lease deadline rather than being
        // acknowledged on behalf of a fenced home.
        if (this.closed) return;
      }
      this.lastFenceAt = this.now().toISOString();
      this.sendAck(socket(), denial.generation);
      return;
    }
    if (assertion.type === "generation") {
      if (assertion.runtimeId === toLogicalRuntimeId(this.options.runtimeId) && assertion.authorityGeneration > this.generation) {
        this.generation = assertion.authorityGeneration;
      }
      // Keepalive: acknowledge with the unchanged fence so the platform records liveness without completing anything new.
      this.sendAck(socket(), this.generation);
      return;
    }
    // membership_assertion frames are pull-authoritative through the membership client; pushed copies only refresh the snapshot.
  }

  /** Registers and connects, retrying with bounded backoff; used at startup. */
  async start(): Promise<void> {
    if (!this.options.startTimers) return;
    await this.registerAndConnect();
    // Startup itself can span the fence: without this the timer is installed behind it and
    // a fenced runtime keeps authenticating to the platform every few minutes, with nothing
    // left to clear the timer.
    this.scheduleReregister();
  }

  /** Self-rescheduling jittered re-registration; never installed or re-armed behind the fence. */
  private scheduleReregister(): void {
    if (this.closed) return;
    const factor = 1 - REREGISTER_JITTER_RATIO + 2 * REREGISTER_JITTER_RATIO * this.jitter();
    this.registerTimer = setTimeout(() => {
      this.registerTimer = undefined;
      this.register().catch((error: unknown) => {
        console.warn("[collaboration-control-client] re-registration failed", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => {
        this.scheduleReregister();
      });
    }, Math.round(REREGISTER_INTERVAL_MS * factor));
    this.registerTimer.unref?.();
  }

  /**
   * Synchronous drain, used by the gateway's synchronous fence. Refuses new frames and
   * reconnects, stops both timers and terminates the stream, which drops every frame
   * queued behind it. Work already inside a frame cannot be cancelled, but it is
   * abandoned at its next resumption point rather than touching torn-down dependencies.
   * Idempotent: a second fence closes nothing twice.
   */
  fence(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.registerTimer) clearTimeout(this.registerTimer);
    this.registerTimer = undefined;
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
  }

  /** Kept async for the ordinary shutdown path; the drain itself has nothing to await. */
  async shutdown(): Promise<void> {
    this.fence();
  }

  private async registerAndConnect(): Promise<void> {
    try {
      const registration = await this.register();
      // Backoff is not reset here: the socket may still be mid-upgrade and fail. It resets
      // when a stream that applied a frame closes after HEALTHY_STREAM_MIN_MS.
      await this.connectControl(registration.controlTicket);
    } catch (error: unknown) {
      console.warn("[collaboration-control-client] registration or control connect failed", error instanceof Error ? error.name : "UnknownError");
      if (error instanceof RegistrationRejectedError && error.retryAfterMs !== undefined) {
        this.retryAfterFloorMs = error.retryAfterMs;
      }
      this.scheduleReconnect("failure");
    }
  }

  /**
   * A failed attempt waits an "equal jitter" delay in [base/2, base] and doubles the base up to
   * MAX_BACKOFF_MS, floored once by a registration Retry-After (itself spread by a bounded jitter).
   * A stream that closes after proving healthy reconnects after a uniform
   * HEALTHY_RECONNECT_MIN_MS..HEALTHY_RECONNECT_MAX_MS delay.
   */
  private scheduleReconnect(reason: "failure" | "healthy_close"): void {
    if (this.closed || !this.options.startTimers || this.reconnectTimer) return;
    let delay: number;
    if (reason === "healthy_close") {
      delay = HEALTHY_RECONNECT_MIN_MS + (HEALTHY_RECONNECT_MAX_MS - HEALTHY_RECONNECT_MIN_MS) * this.jitter();
    } else {
      const base = this.backoffMs;
      delay = base / 2 + (base / 2) * this.jitter();
      this.backoffMs = Math.min(MAX_BACKOFF_MS, base * 2);
    }
    if (this.retryAfterFloorMs !== undefined) {
      const floor = this.retryAfterFloorMs;
      const spread = Math.min(floor * RETRY_AFTER_JITTER_RATIO, MAX_BACKOFF_MS);
      delay = Math.max(delay, floor + spread * this.jitter());
      this.retryAfterFloorMs = undefined;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.registerAndConnect();
    }, Math.round(delay));
    this.reconnectTimer.unref?.();
  }

  /** Injected randomness clamped to [0, 1], so a misbehaving source cannot produce a negative or unbounded delay. */
  private jitter(): number {
    const value = this.random();
    if (!Number.isFinite(value)) return 0.5;
    return Math.min(1, Math.max(0, value));
  }

  private sendAck(socket: ControlSocketLike | undefined, authorityGeneration: number): void {
    const ack: CollaborationControlAck = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      runtimeId: toLogicalRuntimeId(this.options.runtimeId),
      authorityGeneration,
      fenceAt: this.lastFenceAt,
    };
    if (this.closed) return;
    try {
      socket?.send(JSON.stringify(ack));
    } catch (error: unknown) {
      console.warn("[collaboration-control-client] acknowledgement send failed", error instanceof Error ? error.name : "UnknownError");
    }
  }

  private runtimeHeaders(): Record<string, string> {
    return { "x-matrix-runtime-id": this.options.runtimeId, authorization: `Bearer ${this.options.serviceToken}` };
  }
}

export type ControlConnector = (url: string, headers: Record<string, string>, onMessage: (raw: string) => void, onClose: () => void) => ControlSocketLike;

/** Resolves the `ws`-backed connector with an ESM dynamic import; unit tests never open sockets. */
export async function loadDefaultConnector(): Promise<ControlConnector> {
  const { WebSocket } = await import("ws");
  return (url, headers, onMessage, onClose) => {
    const ws = new WebSocket(url, { headers, maxPayload: COLLABORATION_DIRECT_LIMITS.wsFrameBytes });
    ws.on("message", (data, isBinary) => { if (!isBinary) onMessage(data.toString("utf8")); });
    ws.on("close", onClose);
    ws.on("error", (error: Error) => { console.warn("[collaboration-control-client] socket error", error.name); });
    return { send: (value) => ws.send(value), close: (code, reason) => ws.close(code, reason) };
  };
}
