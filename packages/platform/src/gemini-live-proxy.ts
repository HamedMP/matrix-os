import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { getContainer, type PlatformDB } from "./db.js";
import {
  buildPlatformVerificationToken,
  timingSafeTokenEquals,
} from "./platform-token.js";

const GEMINI_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const INTERNAL_GEMINI_LIVE_PATH = /^\/internal\/containers\/([a-z][a-z0-9-]{2,30})\/gemini-live(?:\?.*)?$/;
const MAX_GEMINI_LIVE_PAYLOAD_BYTES = 512 * 1024;

const proxyServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_GEMINI_LIVE_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

export function parseInternalGeminiLivePath(path: string): { handle: string } | null {
  const match = path.match(INTERNAL_GEMINI_LIVE_PATH);
  return match ? { handle: match[1] } : null;
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function handleInternalGeminiLiveProxyUpgrade(opts: {
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  db: PlatformDB;
  platformSecret: string;
  geminiApiKey: string;
  geminiWsUrl?: string;
}): Promise<boolean> {
  const parsed = parseInternalGeminiLivePath(opts.req.url ?? "/");
  if (!parsed) return false;

  if (!opts.platformSecret) {
    rejectUpgrade(opts.socket, 503, "Service Unavailable");
    return true;
  }
  if (!opts.geminiApiKey) {
    rejectUpgrade(opts.socket, 503, "Service Unavailable");
    return true;
  }

  const auth = opts.req.headers.authorization;
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const expected = buildPlatformVerificationToken(parsed.handle, opts.platformSecret);
  if (!timingSafeTokenEquals(token, expected)) {
    rejectUpgrade(opts.socket, 401, "Unauthorized");
    return true;
  }

  const record = await getContainer(opts.db, parsed.handle);
  if (!record?.clerkUserId) {
    rejectUpgrade(opts.socket, 404, "Not Found");
    return true;
  }

  proxyServer.handleUpgrade(opts.req, opts.socket, opts.head, (client) => {
    const provider = new WebSocket(opts.geminiWsUrl ?? GEMINI_WS_URL, {
      headers: { "x-goog-api-key": opts.geminiApiKey },
      perMessageDeflate: false,
      maxPayload: MAX_GEMINI_LIVE_PAYLOAD_BYTES,
    });
    const queued: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    let providerOpen = false;

    const closeBoth = () => {
      client.close();
      provider.close();
    };

    client.on("message", (data, isBinary) => {
      if (provider.readyState === WebSocket.OPEN) {
        provider.send(data, { binary: isBinary });
      } else if (!providerOpen && queued.length < 16) {
        queued.push({ data, isBinary });
      } else {
        closeBoth();
      }
    });
    client.on("close", () => provider.close());
    client.on("error", () => provider.close());

    provider.on("open", () => {
      providerOpen = true;
      while (queued.length > 0 && provider.readyState === WebSocket.OPEN) {
        const item = queued.shift()!;
        provider.send(item.data, { binary: item.isBinary });
      }
    });
    provider.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    provider.on("close", () => client.close());
    provider.on("error", (err) => {
      console.warn("[platform] Gemini Live proxy upstream error:", err instanceof Error ? err.message : String(err));
      client.close();
    });
  });

  return true;
}
