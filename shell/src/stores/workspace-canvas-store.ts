"use client";

import { create } from "zustand";
import { getGatewayUrl } from "@/lib/gateway";

const REQUEST_TIMEOUT_MS = 10_000;
const SAVE_DEBOUNCE_MS = 500;
const LIVE_NODE_BUDGET = 6;

export type WorkspaceCanvasNodeType =
  | "terminal"
  | "pr"
  | "review_loop"
  | "finding"
  | "task"
  | "file"
  | "preview"
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

interface WorkspaceCanvasStore {
  summaries: WorkspaceCanvasSummary[];
  activeCanvasId: string | null;
  document: WorkspaceCanvasDocument | null;
  linkedState: Record<string, unknown> | null;
  selectedNodeId: string | null;
  focusedNodeId: string | null;
  query: string;
  filters: Set<string>;
  saveStatus: SaveStatus;
  error: string | null;
  liveNodeBudget: number;
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
  addEdge: (fromNodeId: string, toNodeId: string, type?: WorkspaceCanvasEdge["type"]) => Promise<void>;
  setSelectedNode: (nodeId: string | null) => void;
  setFocusedNode: (nodeId: string | null) => void;
  setQuery: (query: string) => void;
  toggleFilter: (type: string) => void;
  visibleNodes: () => WorkspaceCanvasNode[];
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${getGatewayUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "Canvas request failed");
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

export const useWorkspaceCanvasStore = create<WorkspaceCanvasStore>((set, get) => ({
  summaries: [],
  activeCanvasId: null,
  document: null,
  linkedState: null,
  selectedNodeId: null,
  focusedNodeId: null,
  query: "",
  filters: new Set(),
  saveStatus: "idle",
  error: null,
  liveNodeBudget: LIVE_NODE_BUDGET,

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
    const existing = get().summaries.find((summary) => summary.scopeType === "pull_request" && JSON.stringify(summary.scopeRef) === JSON.stringify(scopeRef));
    if (existing) {
      await get().openCanvas(existing.id);
      return;
    }
    const created = await requestJson<{ canvasId: string; revision: number }>("/api/canvases", {
      method: "POST",
      body: JSON.stringify({ title, scopeType: "pull_request", scopeRef, template: "pr_workspace" }),
    });
    await get().openCanvas(created.canvasId);
    await get().loadSummaries();
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
        set({ saveStatus: "conflict", error: "Canvas changed elsewhere. Reloaded latest version." });
        await get().openCanvas(document.id);
        set({ saveStatus: "conflict" });
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
    await requestJson(`/api/canvases/${encodeURIComponent(document.id)}`, { method: "DELETE" });
    set({ activeCanvasId: null, document: null, selectedNodeId: null, focusedNodeId: null });
    await get().loadSummaries();
  },

  async exportCanvas() {
    const document = get().document;
    if (!document) return null;
    return requestJson(`/api/canvases/${encodeURIComponent(document.id)}/export`);
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

  async addEdge(fromNodeId, toNodeId, type = "visual") {
    const document = get().document;
    if (!document || fromNodeId === toNodeId) return;
    const edge: WorkspaceCanvasEdge = {
      id: `edge_${Date.now().toString(36)}`,
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
    const filters = new Set(get().filters);
    if (filters.has(type)) filters.delete(type);
    else filters.add(type);
    set({ filters });
  },

  visibleNodes() {
    const { document, query, filters } = get();
    if (!document) return [];
    const needle = query.trim().toLowerCase();
    return document.nodes.filter((node) => {
      if (filters.size > 0 && !filters.has(node.type)) return false;
      if (!needle) return true;
      return JSON.stringify(node).toLowerCase().includes(needle);
    });
  },
}));
