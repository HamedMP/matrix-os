/**
 * Control-stream WebSocket upgrade (S05 / T026).
 *
 * `GET /internal/collaboration/control?ticket=…` admits an enrolled runtime
 * that presents its runtime identity headers and the one-use upgrade ticket
 * returned by registration. The socket carries control assertions and
 * acknowledgements only; every inbound frame is bounded and schema-checked
 * by the stream, and a rejected frame closes the socket.
 */
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { COLLABORATION_DIRECT_LIMITS } from "@matrix-os/contracts";
import type { CollaborationControlStream } from "./control-stream.js";
import { logicalRuntimeIdFor } from "./runtime-identity.js";
import type { AuthenticatedRuntime } from "./direct-routes.js";

export const COLLABORATION_CONTROL_PATH = "/internal/collaboration/control";
const MAX_RAW_PATH_LENGTH = 1_024;
const HEARTBEAT_INTERVAL_MS = 15_000;

export function isCollaborationControlUpgradePath(rawPath: string): boolean {
  if (rawPath.length > MAX_RAW_PATH_LENGTH || /[\r\n]/.test(rawPath)) return false;
  try {
    return new URL(rawPath, "https://platform.invalid").pathname === COLLABORATION_CONTROL_PATH;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[collaboration-control] path parse failed", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

export function createCollaborationControlUpgradeHandler(options: {
  stream: CollaborationControlStream;
  authenticateRuntime(input: { runtimeId: string; bearerToken: string }): Promise<AuthenticatedRuntime | null>;
  heartbeatIntervalMs?: number;
}): {
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean>;
  close(): void;
} {
  const server = new WebSocketServer({ noServer: true, maxPayload: COLLABORATION_DIRECT_LIMITS.wsFrameBytes, perMessageDeflate: false });
  return {
    async handleUpgrade(req, socket, head) {
      const rawPath = req.url ?? "/";
      if (!isCollaborationControlUpgradePath(rawPath)) return false;
      const admitted = await admit(req, rawPath, options);
      if (!admitted) {
        reject(socket, 401);
        return true;
      }
      server.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        let connection: ReturnType<CollaborationControlStream["attach"]>;
        try {
          connection = options.stream.attach(admitted, {
            send: (value) => ws.send(value),
            close: (code, reason) => ws.close(code, reason),
          });
        } catch (error: unknown) {
          console.warn("[collaboration-control] attach failed", error instanceof Error ? error.name : "UnknownError");
          ws.close(1013, "Control stream unavailable");
          return;
        }
        let alive = true;
        const heartbeat = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();
        ws.on("pong", () => {
          alive = true;
          connection.heartbeat();
        });
        ws.on("message", (data, isBinary) => {
          if (isBinary) {
            ws.close(1003, "Binary frames are not accepted");
            return;
          }
          connection.receive(data.toString("utf8")).catch((error: unknown) => {
            console.warn("[collaboration-control] frame rejected", error instanceof Error ? error.name : "UnknownError");
            ws.close(1008, "Invalid frame");
          });
        });
        ws.on("close", () => {
          clearInterval(heartbeat);
          connection.close();
        });
        ws.on("error", (error: Error) => {
          console.warn("[collaboration-control] socket error", error.name);
        });
      });
      return true;
    },
    close() {
      server.close();
    },
  };
}

async function admit(
  req: IncomingMessage,
  rawPath: string,
  options: { stream: CollaborationControlStream; authenticateRuntime(input: { runtimeId: string; bearerToken: string }): Promise<AuthenticatedRuntime | null> },
): Promise<string | null> {
  const runtimeHeader = firstHeader(req.headers["x-matrix-runtime-id"]);
  const authorization = firstHeader(req.headers.authorization);
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (!runtimeHeader || !bearer || bearer.length < 32 || bearer.length > 4_096 || !/^[A-Za-z0-9._~-]+$/.test(bearer)
    || !/^[A-Za-z0-9:_-]{1,128}$/.test(runtimeHeader)) return null;
  const ticket = new URL(rawPath, "https://platform.invalid").searchParams.get("ticket");
  if (!ticket || ticket.length > 256 || !/^[A-Za-z0-9_-]+$/.test(ticket)) return null;
  let runtime: AuthenticatedRuntime | null;
  try {
    runtime = await options.authenticateRuntime({ runtimeId: runtimeHeader, bearerToken: bearer });
  } catch (error: unknown) {
    console.warn("[collaboration-control] runtime authentication failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
  const logical = runtime ? logicalRuntimeIdFor(runtime.runtimeId) : null;
  if (!logical) return null;
  try {
    if (!(await options.stream.consumeUpgradeTicket(ticket, logical))) return null;
  } catch (error: unknown) {
    console.warn("[collaboration-control] ticket consumption failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
  return logical;
}

function reject(socket: Socket, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Service Unavailable"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
