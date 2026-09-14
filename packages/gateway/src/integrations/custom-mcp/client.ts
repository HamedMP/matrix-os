import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { createHash } from "node:crypto";
import { validateCustomMcpUrl } from "./security.js";
import type { CustomMcpTool } from "./types.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOOLS = 100;
const DISCOVERY_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2025-06-18";

export interface RemoteMcpRequest {
  method?: "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface RemoteMcpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type RemoteMcpRequester = (
  request: RemoteMcpRequest,
) => Promise<RemoteMcpResponse>;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseSseBody(raw: string): unknown {
  const messages = raw.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join("\n");
    return data ? [JSON.parse(data)] : [];
  });
  // A response stream may contain related notifications before the actual
  // JSON-RPC response. Return the last id-bearing message to rpc().
  return messages.findLast((message) =>
    Boolean(message) && typeof message === "object" && "id" in (message as object));
}

export const pinnedRemoteMcpRequester: RemoteMcpRequester = async (input) => {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const bodyBytes = body ? Buffer.byteLength(body, "utf8") : 0;
  if (bodyBytes > MAX_REQUEST_BYTES) {
    throw new Error("Custom MCP request exceeds 64 KB limit");
  }
  const target = await validateCustomMcpUrl(input.url);
  const lookup: LookupFunction = ((_hostname, _options, callback) => {
    callback(null, target.address, target.family);
  }) as LookupFunction;

  return new Promise<RemoteMcpResponse>((resolve, reject) => {
    const request = httpsRequest(target.url, {
      method: input.method ?? "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(body === undefined ? {} : { "content-length": String(bodyBytes) }),
        ...input.headers,
      },
      lookup,
      servername: target.url.hostname,
      timeout: input.timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error("Custom MCP redirects are not allowed"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Custom MCP response exceeds 1 MB limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const headers = Object.fromEntries(Object.entries(response.headers)
          .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
          .map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]));
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          const contentType = headers["content-type"] ?? "";
          parsed = raw.length === 0
            ? undefined
            : contentType.includes("text/event-stream")
              ? parseSseBody(raw)
              : JSON.parse(raw);
        } catch (parseError: unknown) {
          console.warn(
            "[custom-mcp] upstream response parse failed:",
            parseError instanceof Error ? parseError.message : String(parseError),
          );
          reject(new Error("Custom MCP returned an invalid response"));
          return;
        }
        resolve({ status, headers, body: parsed });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Custom MCP request timed out")));
    request.on("error", reject);
    request.end(body);
  });
};

export interface RemoteMcpConnection {
  serverId: string;
  url: string;
  authorization?: string;
}

export interface RemoteMcpCall extends RemoteMcpConnection {
  toolName: string;
  arguments?: Record<string, unknown>;
}

interface Session {
  id?: string;
  nextRequestId: number;
  headers: Record<string, string>;
}

interface CachedSession {
  connection: RemoteMcpConnection;
  authorizationFingerprint: string;
  session: Session;
  lastUsed: number;
}

interface PendingInitialization {
  url: string;
  authorizationFingerprint: string;
  promise: Promise<Session>;
}

export class RemoteMcpClient {
  private readonly requester: RemoteMcpRequester;
  private readonly sessions = new Map<string, CachedSession>();
  private readonly initializations = new Map<string, PendingInitialization>();
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private shuttingDown = false;

  constructor(options: { requester?: RemoteMcpRequester; maxSessions?: number; sessionTtlMs?: number; now?: () => number } = {}) {
    this.requester = options.requester ?? pinnedRemoteMcpRequester;
    this.maxSessions = options.maxSessions ?? 50;
    this.sessionTtlMs = options.sessionTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async discover(connection: RemoteMcpConnection): Promise<CustomMcpTool[]> {
    const session = await this.getSession(connection);
    let response;
    try {
      response = await this.rpc(connection, session, "tools/list", {}, DISCOVERY_TIMEOUT_MS);
    } catch (error) {
      await this.evict(connection.serverId);
      throw error;
    }
    const result = response.result as { tools?: unknown } | undefined;
    if (!Array.isArray(result?.tools)) throw new Error("Custom MCP returned an invalid tool catalog");
    if (result.tools.length > MAX_TOOLS) throw new Error("Custom MCP tool limit exceeded");

    return result.tools.map((rawTool) => {
      if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) {
        throw new Error("Custom MCP returned an invalid tool definition");
      }
      const tool = rawTool as { name?: unknown; description?: unknown; inputSchema?: unknown };
      if (typeof tool.name !== "string" || tool.name.length < 1 || tool.name.length > 128) {
        throw new Error("Custom MCP returned an invalid tool name");
      }
      const schema = tool.inputSchema ?? { type: "object" };
      if (byteLength(schema) > MAX_SCHEMA_BYTES) throw new Error("Custom MCP schema limit exceeded");
      const description = typeof tool.description === "string"
        ? tool.description.slice(0, 8_192)
        : "";
      return {
        name: tool.name,
        description,
        inputSchema: schema,
        approval: "always_ask" as const,
        enabled: false,
      };
    });
  }

  async callTool(call: RemoteMcpCall): Promise<unknown> {
    if (byteLength(call.arguments ?? {}) > MAX_REQUEST_BYTES) {
      throw new Error("Custom MCP request exceeds 64 KB limit");
    }
    const session = await this.getSession(call);
    let response;
    try {
      response = await this.rpc(call, session, "tools/call", {
        name: call.toolName,
        arguments: call.arguments ?? {},
      }, TOOL_TIMEOUT_MS);
    } catch (error) {
      await this.evict(call.serverId);
      throw error;
    }
    return response.result;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled(
      [...this.initializations.values()].map((entry) => entry.promise),
    );
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(entries.map((entry) => this.terminate(entry)));
  }

  private baseHeaders(connection: RemoteMcpConnection): Record<string, string> {
    if (connection.authorization?.startsWith("X-API-Key ")) {
      return { "x-api-key": connection.authorization.slice("X-API-Key ".length) };
    }
    return connection.authorization
      ? { authorization: connection.authorization }
      : {};
  }

  private authorizationFingerprint(connection: RemoteMcpConnection): string {
    return createHash("sha256").update(connection.authorization ?? "").digest("base64url");
  }

  private async getSession(connection: RemoteMcpConnection): Promise<Session> {
    if (this.shuttingDown) throw new Error("Custom MCP client is shutting down");
    const now = this.now();
    for (const [serverId, entry] of this.sessions) {
      if (now - entry.lastUsed > this.sessionTtlMs) await this.evict(serverId);
    }
    const fingerprint = this.authorizationFingerprint(connection);
    const existing = this.sessions.get(connection.serverId);
    if (existing && existing.connection.url === connection.url && existing.authorizationFingerprint === fingerprint) {
      existing.lastUsed = now;
      this.sessions.delete(connection.serverId);
      this.sessions.set(connection.serverId, existing);
      return existing.session;
    }
    if (existing) await this.evict(connection.serverId);

    const pending = this.initializations.get(connection.serverId);
    if (pending) {
      if (pending.url === connection.url && pending.authorizationFingerprint === fingerprint) {
        return pending.promise;
      }
      try {
        await pending.promise;
      } catch (initializationError: unknown) {
        console.warn(
          "[custom-mcp] superseded initialization failed:",
          initializationError instanceof Error ? initializationError.message : String(initializationError),
        );
      }
      return this.getSession(connection);
    }
    if (this.initializations.size >= this.maxSessions) {
      throw new Error("Custom MCP session capacity exceeded");
    }

    // Eviction can await an upstream DELETE. Re-check after every awaited
    // eviction so shutdown cannot miss and then leak a late initialization.
    if (this.shuttingDown) throw new Error("Custom MCP client is shutting down");
    const promise = this.initializeAndCache(connection, fingerprint, now);
    this.initializations.set(connection.serverId, {
      url: connection.url,
      authorizationFingerprint: fingerprint,
      promise,
    });
    try {
      return await promise;
    } finally {
      const current = this.initializations.get(connection.serverId);
      if (current?.promise === promise) this.initializations.delete(connection.serverId);
    }
  }

  private async initializeAndCache(
    connection: RemoteMcpConnection,
    authorizationFingerprint: string,
    lastUsed: number,
  ): Promise<Session> {
    const session = await this.initialize(connection);
    this.sessions.set(connection.serverId, {
      connection: { ...connection },
      authorizationFingerprint,
      session,
      lastUsed,
    });
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest) await this.evict(oldest);
    }
    return session;
  }

  private async initialize(connection: RemoteMcpConnection): Promise<Session> {
    const session: Session = {
      nextRequestId: 1,
      headers: this.baseHeaders(connection),
    };
    const response = await this.rpc(connection, session, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "matrix-custom-mcp-broker", version: "1.0.0" },
    }, DISCOVERY_TIMEOUT_MS);
    const result = response.result as { protocolVersion?: unknown } | undefined;
    if (!result || typeof result.protocolVersion !== "string") {
      throw new Error("Custom MCP initialization failed");
    }
    const sessionId = response.headers["mcp-session-id"];
    if (sessionId) {
      if (sessionId.length > 1024 || /[\r\n]/.test(sessionId)) {
        throw new Error("Custom MCP returned an invalid session id");
      }
      session.id = sessionId;
      session.headers["mcp-session-id"] = sessionId;
    }
    session.headers["mcp-protocol-version"] = result.protocolVersion;
    await this.requester({
      url: connection.url,
      headers: session.headers,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    return session;
  }

  private async evict(serverId: string): Promise<void> {
    const entry = this.sessions.get(serverId);
    if (!entry) return;
    this.sessions.delete(serverId);
    try {
      await this.terminate(entry);
    } catch (terminationError: unknown) {
      console.warn(
        "[custom-mcp] session termination failed during eviction:",
        terminationError instanceof Error ? terminationError.message : String(terminationError),
      );
    }
  }

  private async terminate(entry: CachedSession): Promise<void> {
    if (!entry.session.id) return;
    await this.requester({
      method: "DELETE",
      url: entry.connection.url,
      headers: entry.session.headers,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
  }

  private async rpc(
    connection: RemoteMcpConnection,
    session: Session,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<JsonRpcResponse & { headers: Record<string, string> }> {
    const id = session.nextRequestId++;
    const result = await this.requester({
      url: connection.url,
      headers: session.headers,
      body: { jsonrpc: "2.0", id, method, params },
      timeoutMs,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error("Custom MCP server request failed");
    }
    if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) {
      throw new Error("Custom MCP returned an invalid JSON-RPC response");
    }
    const response = result.body as JsonRpcResponse;
    if (response.error) throw new Error("Custom MCP tool returned an error");
    if (response.id !== id) throw new Error("Custom MCP response id mismatch");
    return { ...response, headers: result.headers };
  }
}
