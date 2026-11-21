import { createConnection } from "node:net";
import { GUEST_AGENT_PORT, MAX_LINE_BYTES, type GuestStats } from "./guest-agent/agent.js";

// Host-side client for the guest agent. Cloud Hypervisor exposes the guest's
// vsock as a unix socket (`--vsock ...,socket=<path>`); the host connects,
// writes "CONNECT <port>\n", gets "OK <hostport>\n", and the stream is then the
// guest connection. One connection per request. Messages stay generic.

export type { GuestStats };

export type GuestErrorCode = "unreachable" | "rejected" | "timeout";

export class GuestError extends Error {
  readonly code: GuestErrorCode;

  constructor(code: GuestErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuestError";
    this.code = code;
  }
}

export interface GuestClient {
  stats(signal: AbortSignal): Promise<GuestStats>;
  trim(signal: AbortSignal): Promise<void>;
}

const HANDSHAKE_OK = /^OK \d+$/;
const MAX_BUFFER_BYTES = MAX_LINE_BYTES * 2;
const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EACCES"]);

function request(vsockPath: string, op: "stats" | "trim", signal: AbortSignal): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (signal.aborted) {
      reject(new GuestError("timeout", "guest agent request timed out"));
      return;
    }
    const socket = createConnection(vsockPath);
    let buffer = Buffer.alloc(0);
    let phase: "handshake" | "response" = "handshake";
    let settled = false;

    const finish = (error: GuestError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    function onAbort() {
      finish(new GuestError("timeout", "guest agent request timed out"));
    }
    signal.addEventListener("abort", onAbort, { once: true });

    socket.on("connect", () => socket.write(`CONNECT ${GUEST_AGENT_PORT}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFER_BYTES) {
        finish(new GuestError("rejected", "guest agent response too large"));
        return;
      }
      let index = buffer.indexOf(0x0a);
      while (index >= 0 && !settled) {
        const line = buffer.subarray(0, index).toString("utf8");
        buffer = buffer.subarray(index + 1);
        if (phase === "handshake") {
          if (!HANDSHAKE_OK.test(line)) {
            finish(new GuestError("unreachable", "guest agent port is not reachable"));
            return;
          }
          phase = "response";
          socket.write(`${JSON.stringify({ op })}\n`);
        } else {
          try {
            finish(null, JSON.parse(line));
          } catch (error: unknown) {
            // JSON.parse only throws SyntaxError; any failure here is a bad reply.
            finish(new GuestError("rejected", "guest agent returned invalid JSON", { cause: error }));
          }
          return;
        }
        index = buffer.indexOf(0x0a);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code !== undefined && UNREACHABLE_CODES.has(error.code) ? "unreachable" : "rejected";
      finish(new GuestError(code, "guest agent connection failed", { cause: error }));
    });
    socket.on("close", () => finish(new GuestError("unreachable", "guest agent closed the connection")));
  });
}

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseStats(value: unknown): GuestStats {
  if (typeof value === "object" && value !== null) {
    const { psiSome10, availableMiB, anonMiB } = value as Record<string, unknown>;
    if (isFiniteNonNegative(psiSome10) && isFiniteNonNegative(availableMiB) && isFiniteNonNegative(anonMiB)) {
      return { psiSome10, availableMiB, anonMiB };
    }
  }
  throw new GuestError("rejected", "guest agent returned invalid stats");
}

export function createGuestClient(vsockPath: string): GuestClient {
  return {
    async stats(signal) {
      return parseStats(await request(vsockPath, "stats", signal));
    },
    async trim(signal) {
      const value = await request(vsockPath, "trim", signal);
      if (typeof value !== "object" || value === null || (value as { ok?: unknown }).ok !== true) {
        throw new GuestError("rejected", "guest agent trim failed");
      }
    },
  };
}
