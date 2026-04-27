import { resolve } from "node:path";
import { resolveWithinHome } from "../path-security.js";
import {
  CanvasNodeSchema,
  createBlankCanvasDocument,
  type CanvasAction,
  type CanvasDocumentWrite,
  type CanvasNode,
  type CreateCanvasRequest,
} from "./contracts.js";
import {
  CanvasConflictError,
  CanvasNotFoundError,
  type CanvasOwner,
  type CanvasRecord,
  type CanvasRepository,
} from "./repository.js";

export interface CanvasListResult {
  canvases: Array<{
    id: string;
    title: string;
    scopeType: string;
    scopeRef: Record<string, unknown> | null;
    revision: number;
    updatedAt: string;
    nodeCounts: { total: number; stale: number; live: number };
  }>;
  nextCursor: string | null;
}

export interface CanvasDocumentResult {
  document: CanvasRecord;
  linkedState: {
    terminalSessions: unknown[];
    pullRequests: unknown[];
    reviewLoops: unknown[];
    missingRefs: unknown[];
  };
}

export interface CanvasSafeError {
  error: string;
  status: number;
  latestRevision?: number;
}

export interface CanvasTerminalRegistry {
  create(cwd: string, shell?: string): string;
  getSession(sessionId: string): { sessionId: string; state: "running" | "exited"; attachedClients?: number } | null;
  destroy(sessionId: string): void;
}

export interface CanvasServiceOptions {
  terminalRegistry?: CanvasTerminalRegistry;
  homePath?: string;
  fetchImpl?: typeof fetch;
}

export function mapCanvasError(err: unknown): CanvasSafeError {
  if (err instanceof CanvasConflictError) {
    return { error: "Canvas conflict", status: 409, latestRevision: err.latestRevision };
  }
  if (err instanceof CanvasNotFoundError) {
    return { error: "Canvas not found", status: 404 };
  }
  if (err instanceof SyntaxError) {
    return { error: "Invalid JSON", status: 400 };
  }
  if (err instanceof Error && /payload too large/i.test(err.message)) {
    return { error: "Request body too large", status: 413 };
  }
  console.error("[canvas] Request failed:", err instanceof Error ? err.message : String(err));
  return { error: "Canvas request failed", status: 500 };
}

function ownerFromUser(userId: string): CanvasOwner {
  return { ownerScope: "personal", ownerId: userId };
}

function nodeCounts(record: CanvasRecord) {
  let stale = 0;
  let live = 0;
  for (const node of record.nodes) {
    if (typeof node !== "object" || node === null) continue;
    const displayState = (node as { displayState?: unknown }).displayState;
    const type = (node as { type?: unknown }).type;
    if (displayState === "stale") stale += 1;
    if (type === "terminal" || type === "review_loop" || type === "preview" || type === "app_window") live += 1;
  }
  return { total: record.nodes.length, stale, live };
}

function nowIso(): string {
  return new Date().toISOString();
}

function baseNode(id: string, type: CanvasNode["type"], x: number, y: number, metadata: Record<string, unknown>, sourceRef: CanvasNode["sourceRef"]): CanvasNode {
  const timestamp = nowIso();
  return CanvasNodeSchema.parse({
    id,
    type,
    position: { x, y },
    size: { width: 360, height: type === "terminal" ? 260 : 180 },
    zIndex: 0,
    displayState: "normal",
    sourceRef,
    metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function documentForTemplate(input: CreateCanvasRequest): CanvasDocumentWrite {
  const blank = createBlankCanvasDocument();
  if (input.template !== "pr_workspace" && input.scopeType !== "pull_request") {
    return blank;
  }

  const scopeRef = input.scopeRef ?? {};
  const projectId = typeof scopeRef.projectId === "string" ? scopeRef.projectId : undefined;
  const prId = `pr_${String(scopeRef.owner ?? "repo")}_${String(scopeRef.repo ?? "workspace")}_${String(scopeRef.number ?? "0")}`
    .replace(/[^A-Za-z0-9_-]/g, "_");
  const timestamp = nowIso();
  return {
    schemaVersion: 1,
    nodes: [
      baseNode("node_pr_summary", "pr", 80, 80, {
        title: input.title,
        owner: scopeRef.owner,
        repo: scopeRef.repo,
        number: scopeRef.number,
      }, { kind: "pull_request", id: prId, projectId, external: scopeRef }),
      baseNode("node_review_status", "review_loop", 520, 80, {
        state: "idle",
        findings: 0,
        rounds: [],
        allowedActions: ["review.start", "pr.refresh"],
      }, { kind: "review_loop", id: `review_${prId}`, projectId, external: scopeRef }),
      baseNode("node_terminal_summary", "terminal", 80, 340, {
        label: "Attach terminal",
        mode: "summary",
      }, { kind: "terminal_session", id: "unattached", projectId }),
    ],
    edges: [
      { id: "edge_pr_review", fromNodeId: "node_pr_summary", toNodeId: "node_review_status", type: "reviews" },
    ],
    viewStates: [{ userId: "system", viewport: { x: 0, y: 0, zoom: 1 }, selection: [], filters: {}, groups: [], updatedAt: timestamp }],
    displayOptions: { layout: "pr_workspace" },
  };
}

function safeSearch(records: CanvasRecord[], query?: string): CanvasRecord[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return records;
  return records.filter((record) => {
    const haystack = JSON.stringify([record.title, record.scopeType, record.scopeRef, record.nodes]).toLowerCase();
    return haystack.includes(needle);
  });
}

export class CanvasService {
  private readonly terminalRegistry?: CanvasTerminalRegistry;
  private readonly homePath?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly repository: CanvasRepository, options: CanvasServiceOptions = {}) {
    this.terminalRegistry = options.terminalRegistry;
    this.homePath = options.homePath;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listCanvases(userId: string, query: { scopeType?: string; scopeId?: string; limit?: number; cursor?: string; q?: string } = {}): Promise<CanvasListResult> {
    let records = await this.repository.list(ownerFromUser(userId), query.limit ?? 50);
    if (query.scopeType) records = records.filter((record) => record.scopeType === query.scopeType);
    if (query.scopeId) records = records.filter((record) => JSON.stringify(record.scopeRef ?? {}).includes(query.scopeId ?? ""));
    records = safeSearch(records, query.q);
    return {
      canvases: records.map((record) => ({
        id: record.id,
        title: record.title,
        scopeType: record.scopeType,
        scopeRef: record.scopeRef,
        revision: record.revision,
        updatedAt: record.updatedAt,
        nodeCounts: nodeCounts(record),
      })),
      nextCursor: null,
    };
  }

  async createCanvas(userId: string, input: CreateCanvasRequest): Promise<{ canvasId: string; revision: number }> {
    const record = await this.repository.create(ownerFromUser(userId), {
      title: input.title,
      scopeType: input.scopeType,
      scopeRef: input.scopeRef,
      document: documentForTemplate(input),
    });
    return { canvasId: record.id, revision: record.revision };
  }

  async getCanvas(userId: string, canvasId: string): Promise<CanvasDocumentResult> {
    const record = await this.repository.get(ownerFromUser(userId), canvasId);
    if (!record) throw new CanvasNotFoundError(canvasId);
    return {
      document: record,
      linkedState: this.resolveLinkedState(record),
    };
  }

  async replaceCanvas(
    userId: string,
    canvasId: string,
    input: { baseRevision: number; document: CanvasDocumentWrite },
  ): Promise<{ revision: number; updatedAt: string }> {
    return this.repository.replaceDocument(ownerFromUser(userId), canvasId, input);
  }

  async patchCanvasNode(userId: string, canvasId: string, input: { baseRevision: number; nodeId: string; updates: Record<string, unknown> }): Promise<{ revision: number; updatedAt: string }> {
    if (input.updates.sourceRef && typeof input.updates.sourceRef === "object") {
      const sourceRef = input.updates.sourceRef as { kind?: unknown; id?: unknown };
      if (sourceRef.kind === "file" && typeof sourceRef.id === "string" && this.homePath) {
        if (!resolveWithinHome(this.homePath, sourceRef.id)) {
          throw new CanvasNotFoundError("file");
        }
      }
    }
    return this.repository.patchNode(ownerFromUser(userId), canvasId, input);
  }

  async deleteCanvas(userId: string, canvasId: string): Promise<{ ok: true }> {
    await this.repository.softDelete(ownerFromUser(userId), canvasId);
    return { ok: true };
  }

  async exportCanvas(userId: string, canvasId: string): Promise<{ canvas: CanvasRecord; linkedSummaries: Record<string, unknown>; exportedAt: string }> {
    const record = await this.repository.export(ownerFromUser(userId), canvasId);
    if (!record) throw new CanvasNotFoundError(canvasId);
    return {
      canvas: record,
      linkedSummaries: this.resolveLinkedState(record),
      exportedAt: nowIso(),
    };
  }

  async executeAction(userId: string, canvasId: string, action: CanvasAction): Promise<{ ok: true; result: Record<string, unknown> }> {
    const record = await this.repository.get(ownerFromUser(userId), canvasId);
    if (!record) throw new CanvasNotFoundError(canvasId);
    switch (action.type) {
      case "terminal.create":
        return this.createTerminal(action);
      case "terminal.attach":
      case "terminal.observe":
      case "terminal.write":
      case "terminal.takeover":
        return this.attachTerminal(action);
      case "terminal.kill":
        return this.killTerminal(action);
      case "preview.healthCheck":
        return this.previewHealthCheck(action);
      case "review.start":
      case "review.stop":
      case "review.next":
      case "review.approve":
      case "pr.refresh":
        return { ok: true, result: { kind: "review_action", type: action.type, state: action.type === "review.stop" ? "stopped" : "queued" } };
      case "file.open":
        return this.openFile(action);
      case "custom.validate":
        return { ok: true, result: { kind: "custom_validation", valid: true } };
      default:
        return { ok: true, result: { kind: "noop" } };
    }
  }

  searchNodes(record: CanvasRecord, query: string): unknown[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return record.nodes;
    return record.nodes.filter((node) => JSON.stringify(node).toLowerCase().includes(needle));
  }

  private resolveLinkedState(record: CanvasRecord): CanvasDocumentResult["linkedState"] {
    const terminalSessions: unknown[] = [];
    const pullRequests: unknown[] = [];
    const reviewLoops: unknown[] = [];
    const missingRefs: unknown[] = [];
    for (const node of record.nodes) {
      if (typeof node !== "object" || node === null) continue;
      const sourceRef = (node as { sourceRef?: { kind?: string; id?: string } | null }).sourceRef;
      if (!sourceRef?.id) continue;
      if (sourceRef.kind === "terminal_session") {
        const session = sourceRef.id === "unattached" ? null : this.terminalRegistry?.getSession(sourceRef.id);
        if (session) terminalSessions.push(session);
        else missingRefs.push({ kind: sourceRef.kind, id: sourceRef.id });
      }
      if (sourceRef.kind === "pull_request") pullRequests.push(sourceRef);
      if (sourceRef.kind === "review_loop") reviewLoops.push(sourceRef);
    }
    return { terminalSessions, pullRequests, reviewLoops, missingRefs };
  }

  private createTerminal(action: CanvasAction) {
    if (!this.terminalRegistry) throw new CanvasNotFoundError("terminal-registry");
    const payload = action.payload as { cwd?: string; shell?: string };
    const sessionId = this.terminalRegistry.create(payload.cwd ?? "projects", payload.shell);
    return Promise.resolve({ ok: true as const, result: { kind: "terminal_session", sessionId } });
  }

  private attachTerminal(action: CanvasAction) {
    const sessionId = (action.payload as { sessionId: string }).sessionId;
    const session = this.terminalRegistry?.getSession(sessionId);
    if (!session) throw new CanvasNotFoundError(sessionId);
    return Promise.resolve({ ok: true as const, result: { kind: "terminal_session", sessionId, state: session.state } });
  }

  private killTerminal(action: CanvasAction) {
    const sessionId = (action.payload as { sessionId: string }).sessionId;
    this.terminalRegistry?.destroy(sessionId);
    return Promise.resolve({ ok: true as const, result: { kind: "terminal_session", sessionId, state: "killed" } });
  }

  private async previewHealthCheck(action: CanvasAction) {
    const url = String((action.payload as { url?: unknown }).url ?? "");
    const response = await this.fetchImpl(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: true as const, result: { kind: "preview_health", ok: response.ok, status: response.status } };
  }

  private openFile(action: CanvasAction) {
    const path = String((action.payload as { path?: unknown }).path ?? "");
    if (this.homePath && !resolveWithinHome(this.homePath, path)) {
      throw new CanvasNotFoundError("file");
    }
    return Promise.resolve({ ok: true as const, result: { kind: "file", path: resolve(path) } });
  }
}
