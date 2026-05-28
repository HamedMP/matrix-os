import { normalizeTuiError } from "./errors.js";
import type { TuiGatewayClient } from "./gateway-client.js";
import type { MatrixSessionSummary } from "./session-types.js";

export interface CodingSessionCreateInput {
  projectSlug?: string;
  worktreeId?: string;
  kind: "agent" | "shell";
  agent?: string;
  prompt?: string;
  taskId?: string;
}

export interface CodingSessionListInput {
  projectSlug?: string;
  taskId?: string;
  status?: string;
  limit?: number;
}

export interface CodingAttachResult {
  mode: "observe" | "owner";
  terminalSessionId: string;
}

export interface CodingSessionClient {
  list(input?: CodingSessionListInput): Promise<MatrixSessionSummary[]>;
  get(id: string): Promise<MatrixSessionSummary>;
  create(input: CodingSessionCreateInput): Promise<MatrixSessionSummary>;
  send(id: string, input: string): Promise<MatrixSessionSummary>;
  observe(id: string): Promise<CodingAttachResult>;
  takeover(id: string): Promise<CodingAttachResult>;
  kill(id: string): Promise<MatrixSessionSummary>;
}

type GatewayLike = Pick<TuiGatewayClient, "requestJson">;

function encodeSessionId(id: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) {
    throw normalizeTuiError(Object.assign(new Error("invalid_request"), { code: "invalid_request" }));
  }
  return encodeURIComponent(id);
}

function queryString(input: CodingSessionListInput = {}): string {
  const params = new URLSearchParams();
  if (input.projectSlug) params.set("projectSlug", input.projectSlug);
  if (input.taskId) params.set("taskId", input.taskId);
  if (input.status) params.set("status", input.status);
  if (typeof input.limit === "number") params.set("limit", String(input.limit));
  const value = params.toString();
  return value ? `?${value}` : "";
}

function runtimeStatus(session: Record<string, unknown>): string {
  const runtime = session.runtime;
  if (typeof runtime === "object" && runtime !== null && "status" in runtime && typeof (runtime as { status?: unknown }).status === "string") {
    return (runtime as { status: string }).status;
  }
  return typeof session.status === "string" ? session.status : "unknown";
}

export function normalizeCodingSession(input: unknown): MatrixSessionSummary {
  const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const id = typeof record.id === "string" ? record.id : "unknown";
  const agent = typeof record.agent === "string" ? record.agent : undefined;
  const projectSlug = typeof record.projectSlug === "string" ? record.projectSlug : undefined;
  const prompt = typeof record.prompt === "string" ? record.prompt : undefined;
  return {
    id,
    kind: agent ? "agent" : "task",
    name: prompt ?? id,
    status: runtimeStatus(record),
    projectSlug,
    worktreeId: typeof record.worktreeId === "string" ? record.worktreeId : undefined,
    taskId: typeof record.taskId === "string" ? record.taskId : undefined,
    agent,
    attention: runtimeStatus(record) === "running" ? "busy" : "ready",
    nativeAttachCommand: Array.isArray(record.nativeAttachCommand) ? record.nativeAttachCommand.map(String) : undefined,
  };
}

function sessionFromPayload(payload: unknown): MatrixSessionSummary {
  if (typeof payload === "object" && payload !== null && "session" in payload) {
    return normalizeCodingSession((payload as { session?: unknown }).session);
  }
  return normalizeCodingSession(payload);
}

export function createCodingSessionClient(gateway: GatewayLike): CodingSessionClient {
  return {
    async list(input = {}) {
      const payload = await gateway.requestJson(`/api/sessions${queryString(input)}`);
      if (typeof payload === "object" && payload !== null && "sessions" in payload && Array.isArray((payload as { sessions?: unknown }).sessions)) {
        return (payload as { sessions: unknown[] }).sessions.map(normalizeCodingSession);
      }
      return [];
    },
    async get(id) {
      return sessionFromPayload(await gateway.requestJson(`/api/sessions/${encodeSessionId(id)}`));
    },
    async create(input) {
      return sessionFromPayload(await gateway.requestJson("/api/sessions", { method: "POST", body: JSON.stringify(input) }));
    },
    async send(id, input) {
      return sessionFromPayload(await gateway.requestJson(`/api/sessions/${encodeSessionId(id)}/send`, { method: "POST", body: JSON.stringify({ input }) }));
    },
    async observe(id) {
      return await gateway.requestJson(`/api/sessions/${encodeSessionId(id)}/observe`, { method: "POST", body: JSON.stringify({}) }) as CodingAttachResult;
    },
    async takeover(id) {
      return await gateway.requestJson(`/api/sessions/${encodeSessionId(id)}/takeover`, { method: "POST", body: JSON.stringify({}) }) as CodingAttachResult;
    },
    async kill(id) {
      return sessionFromPayload(await gateway.requestJson(`/api/sessions/${encodeSessionId(id)}`, { method: "DELETE", body: JSON.stringify({}) }));
    },
  };
}
