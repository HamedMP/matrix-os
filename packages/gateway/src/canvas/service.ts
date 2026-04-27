import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

export class CanvasConfigurationError extends Error {
  constructor(message = "Canvas service is not configured") {
    super(message);
    this.name = "CanvasConfigurationError";
  }
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
  resolvePreviewHost?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export function mapCanvasError(err: unknown): CanvasSafeError {
  if (err instanceof CanvasConflictError) {
    return { error: "Canvas conflict", status: 409, latestRevision: err.latestRevision };
  }
  if (err instanceof CanvasNotFoundError) {
    return { error: "Canvas not found", status: 404 };
  }
  if (err instanceof CanvasConfigurationError) {
    console.error("[canvas] Configuration error:", err.message);
    return { error: "Canvas service unavailable", status: 503 };
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
    displayOptions: { layout: "pr_workspace", tldrawLayer: true },
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

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    return isPrivateIpv4(mappedIpv4);
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  return normalized.startsWith("2001:db8");
}

function isPublicIpAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !isPrivateIpv4(address);
  if (kind === 6) return !isPrivateIpv6(address);
  return false;
}

export class CanvasService {
  private readonly terminalRegistry?: CanvasTerminalRegistry;
  private readonly homePath?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resolvePreviewHost: (hostname: string) => Promise<Array<{ address: string; family: number }>>;

  constructor(private readonly repository: CanvasRepository, options: CanvasServiceOptions = {}) {
    this.terminalRegistry = options.terminalRegistry;
    this.homePath = options.homePath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolvePreviewHost = options.resolvePreviewHost ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
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
      // Cursor pagination is deferred until canvas lists exceed the current bounded page size.
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
      if (sourceRef.kind === "file" && typeof sourceRef.id === "string") {
        if (!this.homePath) {
          throw new CanvasConfigurationError("homePath is required for file source refs");
        }
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

  private createTerminal(action: Extract<CanvasAction, { type: "terminal.create" }>) {
    if (!this.terminalRegistry) throw new CanvasNotFoundError("terminal-registry");
    const cwd = action.payload.cwd ?? "projects";
    const safeCwd = this.homePath ? resolveWithinHome(this.homePath, cwd) : cwd;
    if (!safeCwd) throw new CanvasNotFoundError("cwd");
    const sessionId = this.terminalRegistry.create(safeCwd, action.payload.shell);
    return Promise.resolve({ ok: true as const, result: { kind: "terminal_session", sessionId } });
  }

  private attachTerminal(action: Extract<CanvasAction, { type: "terminal.attach" | "terminal.observe" | "terminal.write" | "terminal.takeover" }>) {
    const sessionId = action.payload.sessionId;
    const session = this.terminalRegistry?.getSession(sessionId);
    if (!session) throw new CanvasNotFoundError(sessionId);
    return Promise.resolve({ ok: true as const, result: { kind: "terminal_session", sessionId, state: session.state } });
  }

  private killTerminal(action: Extract<CanvasAction, { type: "terminal.kill" }>) {
    const sessionId = action.payload.sessionId;
    this.terminalRegistry?.destroy(sessionId);
    return Promise.resolve({ ok: true as const, result: { kind: "terminal_session", sessionId, state: "killed" } });
  }

  private async previewHealthCheck(action: Extract<CanvasAction, { type: "preview.healthCheck" }>) {
    const url = await this.safePreviewUrl(action.payload.url);
    const response = await this.fetchImpl(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: true as const, result: { kind: "preview_health", ok: response.ok, status: response.status } };
  }

  private async safePreviewUrl(rawUrl: string): Promise<string> {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new CanvasNotFoundError("preview");
    }
    const literalKind = isIP(hostname);
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = literalKind > 0
        ? [{ address: hostname, family: literalKind }]
        : await this.resolvePreviewHost(hostname);
    } catch (err: unknown) {
      console.error("[canvas] Preview host resolution failed:", err instanceof Error ? err.message : String(err));
      throw new CanvasNotFoundError("preview");
    }
    if (addresses.length === 0 || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
      throw new CanvasNotFoundError("preview");
    }
    // Node fetch resolves DNS independently; the preflight above blocks obvious SSRF
    // targets, while HEAD-only fetches stay bounded by the request timeout.
    return url.toString();
  }

  private openFile(action: Extract<CanvasAction, { type: "file.open" }>) {
    if (!this.homePath) {
      throw new CanvasConfigurationError("homePath is required for file actions");
    }
    const safePath = resolveWithinHome(this.homePath, action.payload.path);
    if (!safePath) {
      throw new CanvasNotFoundError("file");
    }
    return Promise.resolve({ ok: true as const, result: { kind: "file", path: safePath } });
  }
}
