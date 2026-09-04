import { basename } from "node:path";
import { z } from "zod/v4";
import { createMcpError, type SafeMcpErrorCode } from "./errors.js";
import { runtimeApiUrl, type MatrixMcpRuntime } from "./profile-context.js";
import {
  MCP_CHAT_MAX_ITEMS,
  MCP_DIRECTORY_MAX_ENTRIES,
  MCP_FILE_MAX_BYTES,
  MCP_TEXT_FILE_MAX_BYTES,
} from "./schemas.js";

const REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_RESPONSE_GRACE_MS = 30_000;
const JSON_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const SAFE_JSON_MAX_DEPTH = 12;
const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token)/i;

const TerminalSchema = z.object({
  name: z.string().min(1).max(64),
  canonicalName: z.string().min(1).max(64).optional(),
  status: z.enum(["active", "exited"]).optional(),
  createdAt: z.string().max(64).optional(),
  updatedAt: z.string().max(64).optional(),
  attachedClients: z.number().int().nonnegative().max(10_000).optional(),
  placement: z.enum(["active", "background"]).optional(),
  visualStatus: z.enum(["running", "finished", "idle", "waiting"]).optional(),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).optional(),
  cwd: z.string().max(4096).optional(),
  pinned: z.boolean().optional(),
  recoverable: z.boolean().optional(),
}).strip();

const TabSchema = z.object({
  idx: z.number().int().nonnegative().max(1024),
  name: z.string().min(1).max(64).optional(),
  focused: z.boolean().optional(),
  createdAt: z.string().max(64).optional(),
}).strip();

const FileEntrySchema = z.object({
  name: z.string().min(1).max(255).refine((value) => !/[\0\r\n/\\]/.test(value)),
  type: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  gitStatus: z.string().max(32).nullable().optional(),
  changedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  modified: z.string().max(64).optional(),
  created: z.string().max(64).optional(),
  mime: z.string().max(160).optional(),
  children: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strip();

const RunResultSchema = z.object({
  stdout: z.string().max(1024 * 1024),
  stderr: z.string().max(1024 * 1024),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative().max(31 * 60 * 1000),
}).strict().superRefine((result, ctx) => {
  if (Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > MCP_FILE_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "Command output exceeds byte limit" });
  }
});

const CreateTerminalResultSchema = z.object({
  name: z.string().min(1).max(64),
  created: z.literal(true),
}).strict();

const CreateTabResultSchema = z.object({
  tab: z.object({ ok: z.literal(true) }).strict(),
}).strict();

const UploadResultSchema = z.object({
  ok: z.literal(true),
  path: z.string().min(1).max(4096),
  size: z.number().int().nonnegative().max(MCP_FILE_MAX_BYTES),
}).strict();

export interface McpGatewayClientOptions {
  fetch?: typeof fetch;
}

export interface MatrixMcpGatewayClient {
  listTerminals(): Promise<unknown[]>;
  createTerminal(input: { name: string; cwd?: string }): Promise<unknown>;
  listTabs(terminal: string): Promise<unknown[]>;
  createTab(terminal: string, input: { name?: string; cwd?: string }): Promise<unknown>;
  selectTab(terminal: string, tab: number): Promise<void>;
  sendTerminalInput(terminal: string, data: string): Promise<void>;
  runCommand(input: { command: string[]; cwd?: string; timeoutMs?: number }): Promise<z.infer<typeof RunResultSchema>>;
  listFiles(path: string): Promise<unknown[]>;
  readFile(path: string): Promise<{ content: string; size: number; mediaType: string }>;
  downloadFile(path: string): Promise<{ bytes: Buffer; size: number; mediaType: string; filename: string }>;
  uploadFile(path: string, bytes: Buffer, options: { overwrite: boolean; secret: boolean }): Promise<z.infer<typeof UploadResultSchema>>;
  listChats(input: { limit: number; lifecycle?: "active" | "archived"; projectId?: string; cursor?: string }): Promise<unknown>;
  searchChats(input: { query: string; limit: number; projectId?: string }): Promise<unknown>;
  getChat(input: { chatId: string; limit: number; cursor?: string }): Promise<unknown>;
}

function errorCodeForStatus(status: number): SafeMcpErrorCode {
  if (status === 400 || status === 422) return "invalid_input";
  if (status === 401 || status === 403) return "auth_required";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "payload_too_large";
  return "request_failed";
}

function requestError(error: unknown) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
    ? createMcpError("request_timeout")
    : createMcpError("request_failed");
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = contentLength(response);
  if (declared !== null && declared > maxBytes) throw createMcpError("payload_too_large");
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw createMcpError("payload_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await boundedBytes(response, JSON_RESPONSE_MAX_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) throw err;
    throw createMcpError("request_failed");
  }
}

function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > SAFE_JSON_MAX_DEPTH) return "[depth limit]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 128 * 1024);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeJson(item, depth + 1));
  if (typeof value !== "object") return null;
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 500)) {
    if (key.length > 160 || SENSITIVE_KEY.test(key)) continue;
    safe[key] = sanitizeJson(item, depth + 1);
  }
  return safe;
}

function safeChatList(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw createMcpError("request_failed");
  }
  const source = payload as Record<string, unknown>;
  const items = source.items;
  if (!Array.isArray(items)) throw createMcpError("request_failed");
  const nextCursor = typeof source.nextCursor === "string" && /^chatcur_[A-Za-z0-9_-]+$/.test(source.nextCursor)
    ? source.nextCursor.slice(0, 512)
    : undefined;
  return {
    items: items.slice(0, MCP_CHAT_MAX_ITEMS).map((item) => sanitizeJson(item)),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function safeChatDetail(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") throw createMcpError("request_failed");
  const source = payload as Record<string, unknown>;
  if (!source.record || typeof source.record !== "object" || !Array.isArray(source.messages)) {
    throw createMcpError("request_failed");
  }
  const nextCursor = typeof source.nextCursor === "string" && /^chatcur_[A-Za-z0-9_-]+$/.test(source.nextCursor)
    ? source.nextCursor.slice(0, 512)
    : undefined;
  return {
    record: sanitizeJson(source.record),
    messages: source.messages.slice(0, MCP_CHAT_MAX_ITEMS).map((message) => sanitizeJson(message)),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function parseEnvelopeArray(payload: unknown, key: string, schema: z.ZodType): unknown[] {
  if (!payload || typeof payload !== "object" || !(key in payload)) throw createMcpError("request_failed");
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) throw createMcpError("request_failed");
  const parsed = value.slice(0, MCP_DIRECTORY_MAX_ENTRIES).map((item) => schema.safeParse(item));
  if (parsed.some((item) => !item.success)) throw createMcpError("request_failed");
  return parsed.map((item) => item.data);
}

export function createMcpGatewayClient(
  runtime: MatrixMcpRuntime,
  options: McpGatewayClientOptions = {},
): MatrixMcpGatewayClient {
  const fetchImpl = options.fetch ?? fetch;

  function urlFor(apiPath: string, query?: Record<string, string | undefined>): string {
    const url = new URL(runtimeApiUrl(runtime.gatewayUrl, apiPath));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async function request(
    apiPath: string,
    init: RequestInit = {},
    options: { timeoutMs?: number; query?: Record<string, string | undefined> } = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${runtime.token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetchImpl(urlFor(apiPath, options.query), {
        ...init,
        headers: Object.fromEntries(headers.entries()),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      throw requestError(err);
    }
    if (!response.ok) throw createMcpError(errorCodeForStatus(response.status));
    return boundedJson(response);
  }

  async function requestBytes(
    apiPath: string,
    options: { timeoutMs: number; query?: Record<string, string | undefined>; maxBytes: number },
  ): Promise<{ bytes: Buffer; mediaType: string }> {
    let response: Response;
    try {
      response = await fetchImpl(urlFor(apiPath, options.query), {
        headers: { Authorization: `Bearer ${runtime.token}` },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err: unknown) {
      throw requestError(err);
    }
    if (!response.ok) throw createMcpError(errorCodeForStatus(response.status));
    return {
      bytes: await boundedBytes(response, options.maxBytes),
      mediaType: response.headers.get("content-type")?.slice(0, 160) || "application/octet-stream",
    };
  }

  return {
    async listTerminals() {
      return parseEnvelopeArray(await request("/api/terminal/sessions"), "sessions", TerminalSchema);
    },
    async createTerminal(input) {
      const payload = await request("/api/terminal/sessions", { method: "POST", body: JSON.stringify(input) });
      const parsed = CreateTerminalResultSchema.safeParse(payload);
      if (!parsed.success) throw createMcpError("request_failed");
      return parsed.data;
    },
    async listTabs(terminal) {
      return parseEnvelopeArray(
        await request(`/api/terminal/sessions/${encodeURIComponent(terminal)}/tabs`),
        "tabs",
        TabSchema,
      );
    },
    async createTab(terminal, input) {
      const payload = await request(`/api/terminal/sessions/${encodeURIComponent(terminal)}/tabs`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      const parsed = CreateTabResultSchema.safeParse(payload);
      if (!parsed.success) throw createMcpError("request_failed");
      return { created: true };
    },
    async selectTab(terminal, tab) {
      await request(`/api/terminal/sessions/${encodeURIComponent(terminal)}/tabs/${tab}/go`, { method: "POST" });
    },
    async sendTerminalInput(terminal, data) {
      await request(`/api/terminal/sessions/${encodeURIComponent(terminal)}/input`, {
        method: "POST",
        body: JSON.stringify({ data }),
      });
    },
    async runCommand(input) {
      const payload = await request("/api/terminal/run", {
        method: "POST",
        body: JSON.stringify(input),
      }, { timeoutMs: (input.timeoutMs ?? 10 * 60 * 1000) + COMMAND_RESPONSE_GRACE_MS });
      const parsed = RunResultSchema.safeParse(payload);
      if (!parsed.success) throw createMcpError("request_failed");
      return parsed.data;
    },
    async listFiles(path) {
      return parseEnvelopeArray(
        await request("/api/files/list", {}, { query: { path } }),
        "entries",
        FileEntrySchema,
      ).slice(0, MCP_DIRECTORY_MAX_ENTRIES);
    },
    async readFile(path) {
      const result = await requestBytes("/api/files/blob", {
        query: { path },
        maxBytes: MCP_TEXT_FILE_MAX_BYTES,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      } catch (err: unknown) {
        if (!(err instanceof TypeError)) throw err;
        throw createMcpError("invalid_input");
      }
      return { content, size: result.bytes.byteLength, mediaType: result.mediaType };
    },
    async downloadFile(path) {
      const downloaded = await requestBytes("/api/files/blob", {
        query: { path },
        maxBytes: MCP_FILE_MAX_BYTES,
        timeoutMs: 30_000,
      });
      return {
        bytes: downloaded.bytes,
        size: downloaded.bytes.byteLength,
        mediaType: downloaded.mediaType,
        filename: basename(path),
      };
    },
    async uploadFile(path, bytes, uploadOptions) {
      const payload = await request("/api/files/blob", {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      }, {
        timeoutMs: 30_000,
        query: {
          path,
          force: uploadOptions.overwrite ? "true" : undefined,
          secret: uploadOptions.secret ? "true" : undefined,
        },
      });
      const parsed = UploadResultSchema.safeParse(payload);
      if (!parsed.success) throw createMcpError("request_failed");
      return parsed.data;
    },
    async listChats(input) {
      const payload = await request("/api/chats", {}, { query: {
        limit: String(input.limit),
        lifecycle: input.lifecycle,
        projectId: input.projectId,
        cursor: input.cursor,
      } });
      return safeChatList(payload);
    },
    async searchChats(input) {
      const payload = await request("/api/chats/search", {}, { query: {
        query: input.query,
        limit: String(input.limit),
        projectId: input.projectId,
      } });
      return safeChatList(payload);
    },
    async getChat(input) {
      const payload = await request(`/api/chats/${encodeURIComponent(input.chatId)}`, {}, { query: {
        limit: String(Math.min(input.limit, MCP_CHAT_MAX_ITEMS)),
        cursor: input.cursor,
      } });
      return safeChatDetail(payload);
    },
  };
}
