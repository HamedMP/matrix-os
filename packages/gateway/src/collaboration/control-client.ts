/**
 * Control client (S05 / T027, T028).
 *
 * Registers this home with the platform by its enrollment identity, learns
 * the platform ticket verification keys and a one-use control ticket, then
 * holds the control stream: pushed denials end matching direct sessions and
 * are acknowledged with a fence; generation frames move this home's
 * authority generation. Reconnects with bounded backoff; control snapshots
 * have fixed expiry and are never extended by a reconnect.
 */
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationControlAssertionSchema,
  type CollaborationControlAck,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { type DirectSigningKey, toLogicalRuntimeId } from "./direct-auth.js";
import type { DirectSessionService } from "./direct-sessions.js";

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
const CONTROL_SNAPSHOT_TTL_MS = COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds * 1_000;
const REREGISTER_INTERVAL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;

export class CollaborationControlClient {
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

  constructor(private readonly options: {
    platformBaseUrl: string;
    runtimeId: string;
    ownerId: string;
    relayHandle: string;
    serviceToken: string;
    identity: { keyId: string; publicKey: string };
    sessions: Pick<DirectSessionService, "revoke">;
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
    const base = new URL(options.platformBaseUrl);
    if (!["https:", "http:"].includes(base.protocol)) throw new Error("Platform base URL must be http(s)");
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
    const handle: ControlStreamHandle = {
      receive: async (raw) => {
        if (Buffer.byteLength(raw) > COLLABORATION_DIRECT_LIMITS.wsFrameBytes) throw new Error("Control frame too large");
        const assertion = CollaborationControlAssertionSchema.parse(JSON.parse(raw) as unknown);
        this.snapshotExpiresAt = this.now().getTime() + CONTROL_SNAPSHOT_TTL_MS;
        if (assertion.type === "denial") {
          this.options.sessions.revoke(assertion.denial);
          if (assertion.denial.generation > this.generation) this.generation = assertion.denial.generation;
          const ack: CollaborationControlAck = {
            protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
            runtimeId: toLogicalRuntimeId(this.options.runtimeId),
            authorityGeneration: assertion.denial.generation,
            fenceAt: this.now().toISOString(),
          };
          socket?.send(JSON.stringify(ack));
          return;
        }
        if (assertion.type === "generation") {
          if (assertion.runtimeId === toLogicalRuntimeId(this.options.runtimeId) && assertion.authorityGeneration > this.generation) {
            this.generation = assertion.authorityGeneration;
          }
          return;
        }
        // membership_assertion frames are pull-authoritative through the membership client; pushed copies only refresh the snapshot.
      },
      close: () => {
        socket?.close(1001, "Control client closed");
        if (this.stream === handle) this.stream = undefined;
      },
    };
    socket = await connect(url, this.runtimeHeaders(), (raw) => {
      handle.receive(raw).catch((error: unknown) => {
        console.warn("[collaboration-control-client] frame rejected", error instanceof Error ? error.name : "UnknownError");
        handle.close();
      });
    }, () => {
      if (this.stream === handle) this.stream = undefined;
      this.scheduleReconnect();
    });
    this.stream = handle;
    return handle;
  }

  /** Registers and connects, retrying with bounded backoff; used at startup. */
  async start(): Promise<void> {
    if (!this.options.startTimers) return;
    await this.registerAndConnect();
    this.registerTimer = setInterval(() => {
      this.register().catch((error: unknown) => {
        console.warn("[collaboration-control-client] re-registration failed", error instanceof Error ? error.name : "UnknownError");
      });
    }, REREGISTER_INTERVAL_MS);
    this.registerTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.registerTimer) clearInterval(this.registerTimer);
    this.stream?.close();
    this.stream = undefined;
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
