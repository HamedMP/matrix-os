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
 * Reconnects with bounded backoff; control snapshots have fixed expiry and
 * are extended only by an inbound frame, never by a reconnect.
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
const MAX_BACKOFF_MS = 60_000;

export class CollaborationControlClient {
  static readonly MAX_PENDING_CONTROL_FRAMES = MAX_PENDING_CONTROL_FRAMES;
  private keys: DirectSigningKey[] = [];
  private generation = 1;
  private snapshotExpiresAt = 0;
  private closed = false;
  private stream: ControlStreamHandle | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private registerTimer: ReturnType<typeof setInterval> | undefined;
  private backoffMs = 1_000;
  private readonly now: () => Date;
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
    startTimers?: boolean;
    initialGeneration?: number;
  }) {
    this.now = options.now ?? (() => new Date());
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
    if (!response.ok) throw new Error(`Registration rejected (${response.status})`);
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
    let pending = 0;
    const terminate = (): void => {
      if (terminated) return;
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
      if (this.stream === handle) this.stream = undefined;
      this.scheduleReconnect();
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
    // Startup itself can span the fence: without this the interval is installed behind it and
    // a fenced runtime keeps authenticating to the platform every five minutes, with nothing
    // left to clear the timer.
    if (this.closed) return;
    this.registerTimer = setInterval(() => {
      this.register().catch((error: unknown) => {
        console.warn("[collaboration-control-client] re-registration failed", error instanceof Error ? error.name : "UnknownError");
      });
    }, REREGISTER_INTERVAL_MS);
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
    if (this.registerTimer) clearInterval(this.registerTimer);
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
      await this.connectControl(registration.controlTicket);
      this.backoffMs = 1_000;
    } catch (error: unknown) {
      console.warn("[collaboration-control-client] registration or control connect failed", error instanceof Error ? error.name : "UnknownError");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.options.startTimers || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.registerAndConnect();
    }, delay);
    this.reconnectTimer.unref?.();
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
