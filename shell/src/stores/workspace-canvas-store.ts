"use client";

import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";
import { isCanvasAssetMimeType, isCanvasAssetPath } from "../../../packages/gateway/src/canvas/assets";

const REQUEST_TIMEOUT_MS = 10_000;
const SAFE_CANVAS_ERROR_MESSAGES = new Set([
  "Canvas conflict",
  "Canvas not found",
  "Canvas request failed",
  "Canvas service unavailable",
  "Invalid JSON",
  "Invalid request",
  "Request body too large",
  "Unauthorized",
]);
const UNSAFE_CANVAS_ERROR_MESSAGE = /(postgres|sqlite|mysql|pipedream|twilio|openai|anthropic|\/home\/|\/tmp\/|stack|constraint|zod|issues)/i;

function safeCanvasErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "Canvas request failed";
  const message = value.trim();
  if (message.length > 80 || UNSAFE_CANVAS_ERROR_MESSAGE.test(message)) {
    return "Canvas request failed";
  }
  return SAFE_CANVAS_ERROR_MESSAGES.has(message) ? message : "Canvas request failed";
}
const SAVE_DEBOUNCE_MS = 500;

export type WorkspaceCanvasNodeType =
  | "terminal"
  | "pr"
  | "review_loop"
  | "finding"
  | "task"
  | "file"
  | "preview"
  | "image"
  | "note"
  | "app_window"
  | "issue"
  | "custom"
  | "fallback";

export interface WorkspaceCanvasNode {
  id: string;
  type: WorkspaceCanvasNodeType;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  collapsed?: boolean;
  displayState: "normal" | "minimized" | "summary" | "stale" | "missing" | "unauthorized" | "failed" | "recoverable";
  sourceRef: { kind: string; id: string; projectId?: string; external?: Record<string, unknown> } | null;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceCanvasEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: "visual" | "depends_on" | "implements" | "reviews" | "opens" | "related";
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceCanvasDocument {
  id: string;
  title: string;
  revision: number;
  schemaVersion: 1;
  scopeType: string;
  scopeRef: Record<string, unknown> | null;
  nodes: WorkspaceCanvasNode[];
  edges: WorkspaceCanvasEdge[];
  viewStates: unknown[];
  displayOptions: Record<string, unknown>;
}

export interface WorkspaceCanvasSummary {
  id: string;
  title: string;
  scopeType: string;
  scopeRef: Record<string, unknown> | null;
  revision: number;
  updatedAt: string;
  nodeCounts: { total: number; stale: number; live: number };
}

type SaveStatus = "idle" | "saving" | "saved" | "conflict" | "error";

export interface CanvasAssetUpload {
  assetId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
}

function parseCanvasAssetUpload(value: unknown): CanvasAssetUpload | null {
  if (typeof value !== "object" || value === null) return null;
  const asset = value as Record<string, unknown>;
  if (typeof asset.assetId !== "string" || asset.assetId.length < 1 || asset.assetId.length > 120) return null;
  if (typeof asset.path !== "string" || !isCanvasAssetPath(asset.path)) return null;
  if (typeof asset.mimeType !== "string" || !isCanvasAssetMimeType(asset.mimeType)) return null;
  if (typeof asset.sizeBytes !== "number" || !Number.isFinite(asset.sizeBytes) || asset.sizeBytes <= 0) return null;
  if (typeof asset.originalName !== "string" || asset.originalName.length < 1 || asset.originalName.length > 160) return null;
  return {
    assetId: asset.assetId,
    path: asset.path,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    originalName: asset.originalName,
  };
}

interface WorkspaceCanvasStore {
  summaries: WorkspaceCanvasSummary[];
  activeCanvasId: string | null;
  document: WorkspaceCanvasDocument | null;
  linkedState: Record<string, unknown> | null;
  selectedNodeId: string | null;
  focusedNodeId: string | null;
  query: string;
  filters: string[];
  saveStatus: SaveStatus;
  error: string | null;
  loadSummaries: () => Promise<void>;
  openCanvas: (canvasId: string) => Promise<void>;
  openPrCanvas: (scopeRef: Record<string, unknown>, title?: string) => Promise<void>;
  saveDocument: (document: WorkspaceCanvasDocument) => Promise<void>;
  scheduleSave: (document: WorkspaceCanvasDocument) => void;
  updateNode: (nodeId: string, updates: Partial<WorkspaceCanvasNode>) => Promise<void>;
  deleteCanvas: () => Promise<void>;
  exportCanvas: () => Promise<unknown | null>;
  executeAction: (nodeId: string, type: string, payload?: Record<string, unknown>) => Promise<unknown | null>;
  addNode: (type: WorkspaceCanvasNodeType, metadata?: Record<string, unknown>) => Promise<void>;
  addImageNode: (asset: CanvasAssetUpload, dimensions: { width: number; height: number }, center: { x: number; y: number }, options?: { canvasId?: string }) => Promise<void>;
  uploadCanvasAsset: (file: File) => Promise<CanvasAssetUpload | null>;
  deleteNode: (nodeId: string) => Promise<void>;
  addEdge: (fromNodeId: string, toNodeId: string, type?: WorkspaceCanvasEdge["type"]) => Promise<void>;
  setSelectedNode: (nodeId: string | null) => void;
  setFocusedNode: (nodeId: string | null) => void;
  setQuery: (query: string) => void;
  toggleFilter: (type: string) => void;
  visibleNodes: () => WorkspaceCanvasNode[];
}

export function selectVisibleWorkspaceCanvasNodes(
  document: WorkspaceCanvasDocument | null,
  query: string,
  filters: string[],
): WorkspaceCanvasNode[] {
  if (!document) return [];
  const needle = query.trim().toLowerCase();
  return document.nodes.filter((node) => {
    if (filters.length > 0 && !filters.includes(node.type)) return false;
    if (!needle) return true;
    return JSON.stringify(node).toLowerCase().includes(needle);
  });
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getGatewayUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = {};
  try {
    body = await response.json();
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) {
      console.warn("[workspace-canvas] Failed to parse gateway response:", err);
      if (response.ok) {
        throw new Error("Canvas request failed");
      }
    }
  }
  if (!response.ok) {
    throw new Error(safeCanvasErrorMessage((body as { error?: unknown }).error));
  }
  return body as T;
}

function writableDocument(document: WorkspaceCanvasDocument) {
  return {
    schemaVersion: 1 as const,
    nodes: document.nodes,
    edges: document.edges,
    viewStates: document.viewStates ?? [],
    displayOptions: document.displayOptions ?? {},
  };
}

function createNode(type: WorkspaceCanvasNodeType, metadata: Record<string, unknown>, index: number): WorkspaceCanvasNode {
  const id = `node_${type}_${Date.now().toString(36)}_${index}`;
  const now = new Date().toISOString();
  const sourceRef =
    type === "note" || type === "fallback" || type === "custom"
      ? null
      : { kind: type === "pr" ? "pull_request" : type, id };
  return {
    id,
    type,
    position: { x: 120 + index * 40, y: 120 + index * 40 },
    size: { width: type === "terminal" ? 520 : 360, height: type === "terminal" ? 320 : 180 },
    zIndex: index,
    displayState: "normal",
    sourceRef,
    metadata: type === "custom" ? { customType: "local", customVersion: 1, ...metadata } : metadata,
    createdAt: now,
    updatedAt: now,
  };
}

function createEdgeId(index: number): string {
  const entropy = Math.random().toString(36).slice(2, 10);
  return `edge_${Date.now().toString(36)}_${index}_${entropy}`;
}

function createImageNode(
  asset: CanvasAssetUpload,
  dimensions: { width: number; height: number },
  center: { x: number; y: number },
  index: number,
): WorkspaceCanvasNode {
  const entropy = Math.random().toString(36).slice(2, 10);
  const id = `node_image_${Date.now().toString(36)}_${index}_${entropy}`;
  const now = new Date().toISOString();
  return {
    id,
    type: "image",
    position: { x: Math.round(center.x - dimensions.width / 2), y: Math.round(center.y - dimensions.height / 2) },
    size: { width: Math.round(dimensions.width), height: Math.round(dimensions.height) },
    zIndex: index,
    displayState: "normal",
    sourceRef: { kind: "file", id: asset.path },
    metadata: {
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      originalName: asset.originalName,
      width: Math.round(dimensions.width),
      height: Math.round(dimensions.height),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export const useWorkspaceCanvasStore = create<WorkspaceCanvasStore>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  return {
  summaries: [],
  activeCanvasId: null,
  document: null,
  linkedState: null,
  selectedNodeId: null,
  focusedNodeId: null,
  query: "",
  filters: [],
  saveStatus: "idle",
  error: null,

  async loadSummaries() {
    try {
      const result = await requestJson<{ canvases: WorkspaceCanvasSummary[] }>("/api/canvases");
      set({ summaries: result.canvases, error: null });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : "Canvas request failed" });
    }
  },

  async openCanvas(canvasId) {
    try {
      const result = await requestJson<{ document: WorkspaceCanvasDocument; linkedState: Record<string, unknown> }>(`/api/canvases/${encodeURIComponent(canvasId)}`);
      set({ activeCanvasId: canvasId, document: result.document, linkedState: result.linkedState, saveStatus: "idle", error: null });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : "Canvas request failed" });
    }
  },

  async openPrCanvas(scopeRef, title = "Pull Request Workspace") {
    try {
      const existing = get().summaries.find((summary) => summary.scopeType === "pull_request" && JSON.stringify(summary.scopeRef) === JSON.stringify(scopeRef));
      if (existing) {
        await get().openCanvas(existing.id);
        return;
      }
      const created = await requestJson<{ canvasId: string; revision: number }>("/api/canvases", {
        method: "POST",
        body: JSON.stringify({ title, scopeType: "pull_request", scopeRef, template: "pr_workspace" }),
      });
      set({
        summaries: [
          {
            id: created.canvasId,
            title,
            scopeType: "pull_request",
            scopeRef,
            revision: created.revision,
            updatedAt: new Date().toISOString(),
            nodeCounts: { total: 0, stale: 0, live: 0 },
          },
          ...get().summaries.filter((summary) => summary.id !== created.canvasId),
        ],
      });
      await get().openCanvas(created.canvasId);
      await get().loadSummaries();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Canvas request failed";
      set({ error: message });
      await get().loadSummaries();
      set({ error: message });
    }
  },

  async saveDocument(document) {
    set({ saveStatus: "saving" });
    try {
      const result = await requestJson<{ revision: number; updatedAt: string }>(`/api/canvases/${encodeURIComponent(document.id)}`, {
        method: "PUT",
        body: JSON.stringify({ baseRevision: document.revision, document: writableDocument(document) }),
      });
      set({ document: { ...document, revision: result.revision }, saveStatus: "saved", error: null });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Canvas request failed";
      if (/conflict/i.test(message)) {
        set({
          saveStatus: "conflict",
          error: "Canvas changed elsewhere. Local edits were kept; reload latest before saving again.",
        });
        return;
      }
      set({ saveStatus: "error", error: message });
    }
  },

  scheduleSave(document) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void get().saveDocument(document);
    }, SAVE_DEBOUNCE_MS);
  },

  async updateNode(nodeId, updates) {
    const document = get().document;
    if (!document) return;
    const updated = {
      ...document,
      nodes: document.nodes.map((node) => (node.id === nodeId ? { ...node, ...updates, updatedAt: new Date().toISOString() } : node)),
    };
    set({ document: updated });
    get().scheduleSave(updated);
  },

  async deleteCanvas() {
    const document = get().document;
    if (!document) return;
    try {
      await requestJson(`/api/canvases/${encodeURIComponent(document.id)}`, { method: "DELETE" });
      set({
        activeCanvasId: null,
        document: null,
        selectedNodeId: null,
        focusedNodeId: null,
        summaries: get().summaries.filter((summary) => summary.id !== document.id),
        error: null,
      });
      await get().loadSummaries();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : "Canvas request failed" });
    }
  },

  async exportCanvas() {
    const document = get().document;
    if (!document) return null;
    try {
      const result = await requestJson(`/api/canvases/${encodeURIComponent(document.id)}/export`);
      set({ error: null });
      return result;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : "Canvas request failed" });
      return null;
    }
  },

  async executeAction(nodeId, type, payload = {}) {
    const document = get().document;
    if (!document) return null;
    try {
      const result = await requestJson(`/api/canvases/${encodeURIComponent(document.id)}/actions`, {
        method: "POST",
        body: JSON.stringify({ nodeId, type, payload }),
      });
      set({ error: null });
      return result;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : "Canvas request failed" });
      return null;
    }
  },

  async addNode(type, metadata = {}) {
    const document = get().document;
    if (!document) return;
    const nextNode = createNode(type, metadata, document.nodes.length);
    const next = { ...document, nodes: [...document.nodes, nextNode] };
    set({ document: next, selectedNodeId: nextNode.id });
    get().scheduleSave(next);
  },

  async addImageNode(asset, dimensions, center, options = {}) {
    const document = get().document;
    if (!document || (options.canvasId && document.id !== options.canvasId)) return;
    const nextNode = createImageNode(asset, dimensions, center, document.nodes.length);
    const next = { ...document, nodes: [...document.nodes, nextNode] };
    set({ document: next, selectedNodeId: nextNode.id });
    get().scheduleSave(next);
  },

  async uploadCanvasAsset(file) {
    const document = get().document;
    if (!document) return null;
    const formData = new FormData();
    formData.append("file", file, file.name || "clipboard-image");
    try {
      const response = await fetch(`${getGatewayUrl()}/api/canvases/${encodeURIComponent(document.id)}/assets`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let body: unknown = {};
      try {
        body = await response.json();
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError)) {
          console.warn("[workspace-canvas] Failed to parse asset upload response:", err);
        }
      }
      if (!response.ok) {
        throw new Error(safeCanvasErrorMessage((body as { error?: unknown }).error));
      }
      const asset = parseCanvasAssetUpload(body);
      if (!asset) {
        throw new Error("Canvas request failed");
      }
      set({ error: null });
      return asset;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : "Canvas request failed" });
      return null;
    }
  },

  async deleteNode(nodeId) {
    const document = get().document;
    if (!document) return;
    const next = {
      ...document,
      nodes: document.nodes.filter((node) => node.id !== nodeId),
      edges: document.edges.filter((edge) => edge.fromNodeId !== nodeId && edge.toNodeId !== nodeId),
    };
    set({
      document: next,
      selectedNodeId: get().selectedNodeId === nodeId ? null : get().selectedNodeId,
      focusedNodeId: get().focusedNodeId === nodeId ? null : get().focusedNodeId,
    });
    get().scheduleSave(next);
  },

  async addEdge(fromNodeId, toNodeId, type = "visual") {
    const document = get().document;
    if (!document || fromNodeId === toNodeId) return;
    const edge: WorkspaceCanvasEdge = {
      id: createEdgeId(document.edges.length),
      fromNodeId,
      toNodeId,
      type,
    };
    const next = { ...document, edges: [...document.edges, edge] };
    set({ document: next });
    get().scheduleSave(next);
  },

  setSelectedNode(nodeId) {
    set({ selectedNodeId: nodeId });
  },

  setFocusedNode(nodeId) {
    set({ focusedNodeId: nodeId });
  },

  setQuery(query) {
    set({ query });
  },

  toggleFilter(type) {
    const filters = get().filters.includes(type)
      ? get().filters.filter((filter) => filter !== type)
      : [...get().filters, type];
    set({ filters });
  },

  visibleNodes() {
    const { document, query, filters } = get();
    return selectVisibleWorkspaceCanvasNodes(document, query, filters);
  },
  };
});
