import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import type { MatrixProject } from "./project-match.js";
import type { RemoteCommand } from "./remote-scripts.js";

const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 180_000;
const RUN_GRACE_MS = 15_000;

export class HandoffApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "HandoffApiError";
  }
}

const ProjectSchema = z.object({
  id: z.string().min(1).max(160),
  slug: z.string().min(1).max(63),
  name: z.string().max(256),
  kind: z.string().max(32),
  localPath: z.string().min(1).max(4096),
  remote: z.string().max(1024).optional(),
  defaultBranch: z.string().max(200).optional(),
  github: z.object({ owner: z.string().max(100), repo: z.string().max(100) }).optional(),
  archivedAt: z.string().max(64).optional(),
  deletingAt: z.string().max(64).optional(),
});
const ProjectListSchema = z.object({ projects: z.array(ProjectSchema).max(5000) });
const ProjectEnvelopeSchema = z.object({ project: ProjectSchema });

const WorktreeSchema = z.object({
  id: z.string().regex(/^wt_[a-z0-9]{12,40}$/),
  path: z.string().min(1).max(4096),
  currentBranch: z.string().max(200).optional(),
});
const WorktreeEnvelopeSchema = z.object({ worktree: WorktreeSchema });
const WorktreeListSchema = z.object({ worktrees: z.array(WorktreeSchema).max(2000) });

const SelectionOptionSchema = z.object({ id: z.string().max(80), value: z.union([z.string().max(200), z.boolean()]) });
const ProviderInstanceSchema = z.object({
  id: z.string().max(160),
  driverKind: z.string().max(80),
  displayName: z.string().max(160).optional(),
  availability: z.string().max(40),
  models: z.array(z.object({ id: z.string().max(160), availability: z.string().max(40).optional() })).max(200).default([]),
  setupActions: z.array(z.object({ kind: z.string().max(80).optional(), command: z.string().max(400).optional() }).loose()).max(20).default([]),
  supports: z.object({
    interactionModes: z.array(z.string().max(80)).max(20).default([]),
    permissionModes: z.array(z.string().max(80)).max(20).default([]),
  }).loose().optional(),
  defaultSelection: z.object({
    model: z.string().max(160),
    options: z.array(SelectionOptionSchema).max(32).optional(),
  }).loose().optional(),
}).loose();
const ProviderCatalogSchema = z.object({ instances: z.array(ProviderInstanceSchema).max(200) }).loose();

const ChatRecordSchema = z.object({ chat: z.object({ id: z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/), revision: z.number().int().min(0) }).loose() }).loose();
const TurnAcceptedSchema = z.object({ admission: z.string().max(40).optional() }).loose();
const RunResultSchema = z.object({
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  exitCode: z.number().int().nullable().default(null),
}).loose();
const ErrorBodySchema = z.object({
  error: z.union([z.string().max(200), z.object({ code: z.string().max(80).optional(), message: z.string().max(400).optional() }).loose()]).optional(),
  code: z.string().max(80).optional(),
}).loose();

export type ProviderInstance = z.infer<typeof ProviderInstanceSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;

export interface ChatSelection {
  instanceId: string;
  model: string;
  options?: { id: string; value: string | boolean }[];
}

export interface HandoffGateway {
  listProjects(): Promise<MatrixProject[]>;
  createProject(body: Record<string, unknown>): Promise<MatrixProject>;
  listWorktrees(slug: string): Promise<Worktree[]>;
  createWorktree(slug: string, branch: string): Promise<Worktree>;
  providerCatalog(): Promise<ProviderInstance[]>;
  createChat(body: { clientRequestId: string; title: string; projectId: string; currentSelection: ChatSelection }): Promise<{ id: string; revision: number }>;
  startTurn(chatId: string, body: Record<string, unknown>): Promise<void>;
  run(command: RemoteCommand): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
}

function errorCode(body: unknown): string {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) return "request_failed";
  const error = parsed.data.error;
  if (typeof error === "string") return /^[a-z0-9_]{1,80}$/.test(error) ? error : "request_failed";
  return error?.code ?? parsed.data.code ?? "request_failed";
}

export function createHandoffGateway(options: { gatewayUrl: string; token: string; fetchImpl?: typeof fetch }): HandoffGateway {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.gatewayUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit & { timeoutMs?: number }, schema: z.ZodType<T>): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        authorization: `Bearer ${options.token}`,
        ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(init.timeoutMs ?? API_TIMEOUT_MS),
    });
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        body = null;
      }
    }
    if (!response.ok) {
      throw new HandoffApiError(`Matrix request failed (${response.status})`, response.status, errorCode(body));
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HandoffApiError("Matrix returned an unexpected response", response.status, "invalid_response");
    return parsed.data;
  }

  const json = (value: unknown) => JSON.stringify(value);

  return {
    async listProjects() {
      return (await request("/api/workspace/projects?visibility=active", { method: "GET" }, ProjectListSchema)).projects;
    },
    async createProject(body) {
      return (await request("/api/projects", { method: "POST", body: json(body), timeoutMs: 10 * 60_000 }, ProjectEnvelopeSchema)).project;
    },
    async listWorktrees(slug) {
      return (await request(`/api/projects/${encodeURIComponent(slug)}/worktrees`, { method: "GET" }, WorktreeListSchema)).worktrees;
    },
    async createWorktree(slug, branch) {
      return (await request(
        `/api/projects/${encodeURIComponent(slug)}/worktrees`,
        { method: "POST", body: json({ branch }), timeoutMs: 5 * 60_000 },
        WorktreeEnvelopeSchema,
      )).worktree;
    },
    async providerCatalog() {
      const query = "includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true&includeChatFunding=true";
      return (await request(`/api/chat-providers?${query}`, { method: "GET" }, ProviderCatalogSchema)).instances;
    },
    async createChat(body) {
      const record = await request("/api/chats", { method: "POST", body: json(body) }, ChatRecordSchema);
      return { id: record.chat.id, revision: record.chat.revision };
    },
    async startTurn(chatId, body) {
      await request(`/api/chats/${encodeURIComponent(chatId)}/turns`, { method: "POST", body: json(body) }, TurnAcceptedSchema);
    },
    async run(command) {
      return await request(
        "/api/terminal/run",
        { method: "POST", body: json(command), timeoutMs: command.timeoutMs + RUN_GRACE_MS },
        RunResultSchema,
      );
    },
    async uploadFile(localPath, remotePath) {
      const url = new URL("/api/files/blob", `${base}/`);
      url.searchParams.set("path", remotePath);
      url.searchParams.set("force", "true");
      const bytes = await readFile(localPath);
      await request(
        `${url.pathname}${url.search}`,
        { method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" }, timeoutMs: UPLOAD_TIMEOUT_MS },
        z.object({ ok: z.literal(true) }).loose(),
      );
    },
  };
}
