import { z } from "zod/v4";

export const CANVAS_DOCUMENT_MAX_BYTES = 256 * 1024;
export const CANVAS_NODE_METADATA_MAX_BYTES = 16 * 1024;
export const CANVAS_EDGE_METADATA_MAX_BYTES = 4 * 1024;
export const CANVAS_MAX_NODES = 500;
export const CANVAS_MAX_EDGES = 1000;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UNSAFE_CLIENT_ERROR = /(postgres|sqlite|mysql|pipedream|twilio|openai|anthropic|\/home\/|\/tmp\/|stack|constraint|zod|issues)/i;

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedJson(maxBytes: number) {
  return z.record(z.string(), z.unknown()).refine((value) => jsonSize(value) <= maxBytes, {
    message: "Object exceeds size limit",
  });
}

function safePrefixedId(prefix: string, minLength = 1) {
  return z.string()
    .min(prefix.length + minLength)
    .max(prefix.length + 80)
    .startsWith(prefix)
    .refine((value) => SAFE_ID.test(value.slice(prefix.length)), { message: "Invalid id" });
}

function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function safeRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\0")) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === ".." || segment === "");
}

export const CanvasIdSchema = safePrefixedId("cnv_", 8);
export const CanvasNodeIdSchema = safePrefixedId("node_");
export const CanvasEdgeIdSchema = safePrefixedId("edge_");
export const CanvasRevisionSchema = z.number().int().min(1);
export const CanvasDateSchema = z.string().regex(ISO_DATETIME);

export const CanvasScopeTypeSchema = z.enum(["global", "project", "task", "pull_request", "review_loop"]);
export const CanvasOwnerScopeSchema = z.enum(["personal", "org"]);

export const CanvasNodeTypeSchema = z.enum([
  "terminal",
  "pr",
  "review_loop",
  "finding",
  "task",
  "file",
  "preview",
  "note",
  "app_window",
  "issue",
  "custom",
  "fallback",
]);

export const CanvasDisplayStateSchema = z.enum([
  "normal",
  "minimized",
  "summary",
  "stale",
  "missing",
  "unauthorized",
  "failed",
  "recoverable",
]);

export const NodeSourceKindSchema = z.enum([
  "terminal_session",
  "project",
  "task",
  "pull_request",
  "review_loop",
  "review_finding",
  "file",
  "url",
  "app_window",
  "github_issue",
  "custom",
]);

export const NodeSourceRefSchema = z.object({
  kind: NodeSourceKindSchema,
  id: z.string().min(1).max(256),
  projectId: z.string().min(1).max(120).optional(),
  external: z.record(z.string(), z.unknown()).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "url" && !safeUrl(value.id)) {
    ctx.addIssue({ code: "custom", message: "Unsafe URL", path: ["id"] });
  }
  if (value.kind === "file" && !safeRelativePath(value.id)) {
    ctx.addIssue({ code: "custom", message: "Unsafe file path", path: ["id"] });
  }
});

export const CanvasPositionSchema = z.object({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
});

export const CanvasSizeSchema = z.object({
  width: z.number().finite().min(80).max(4000),
  height: z.number().finite().min(60).max(4000),
});

export const CanvasNodeSchema = z.object({
  id: CanvasNodeIdSchema,
  type: CanvasNodeTypeSchema,
  position: CanvasPositionSchema,
  size: CanvasSizeSchema,
  zIndex: z.number().int().min(-100_000).max(100_000).default(0),
  collapsed: z.boolean().optional().default(false),
  displayState: CanvasDisplayStateSchema.default("normal"),
  sourceRef: NodeSourceRefSchema.nullable(),
  metadata: boundedJson(CANVAS_NODE_METADATA_MAX_BYTES).default({}),
  createdAt: CanvasDateSchema.optional(),
  updatedAt: CanvasDateSchema.optional(),
}).superRefine((value, ctx) => {
  if (!["note", "fallback", "custom"].includes(value.type) && value.sourceRef === null) {
    ctx.addIssue({ code: "custom", message: "sourceRef is required", path: ["sourceRef"] });
  }
  if (value.type === "custom") {
    const metadata = value.metadata as Record<string, unknown>;
    if (typeof metadata.customType !== "string" || typeof metadata.customVersion !== "number") {
      ctx.addIssue({ code: "custom", message: "Custom nodes require type and version metadata", path: ["metadata"] });
    }
  }
  if (value.type === "preview" && value.sourceRef?.kind === "url" && !safeUrl(value.sourceRef.id)) {
    ctx.addIssue({ code: "custom", message: "Unsafe preview URL", path: ["sourceRef", "id"] });
  }
});

export const CanvasEdgeTypeSchema = z.enum(["visual", "depends_on", "implements", "reviews", "opens", "related"]);

export const CanvasEdgeSchema = z.object({
  id: CanvasEdgeIdSchema,
  fromNodeId: CanvasNodeIdSchema,
  toNodeId: CanvasNodeIdSchema,
  type: CanvasEdgeTypeSchema.default("visual"),
  label: z.string().min(1).max(80).optional(),
  metadata: boundedJson(CANVAS_EDGE_METADATA_MAX_BYTES).optional(),
}).superRefine((value, ctx) => {
  if (value.fromNodeId === value.toNodeId) {
    ctx.addIssue({ code: "custom", message: "Self edges are not allowed", path: ["toNodeId"] });
  }
  const metadata = value.metadata as Record<string, unknown> | undefined;
  if (metadata && ("mutateDomain" in metadata || "domainMutation" in metadata || "sourceOfTruthWrite" in metadata)) {
    ctx.addIssue({ code: "custom", message: "Edges cannot mutate domain records", path: ["metadata"] });
  }
});

export const CanvasViewStateSchema = z.object({
  userId: z.string().min(1).max(120),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().min(0.1).max(4),
  }),
  selection: z.array(z.union([CanvasNodeIdSchema, CanvasEdgeIdSchema])).max(100).default([]),
  focusedNodeId: CanvasNodeIdSchema.optional(),
  filters: boundedJson(4096).default({}),
  groups: z.array(boundedJson(4096)).max(100).default([]),
  updatedAt: CanvasDateSchema.optional(),
});

export const CanvasDocumentWriteSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(CanvasNodeSchema).max(CANVAS_MAX_NODES),
  edges: z.array(CanvasEdgeSchema).max(CANVAS_MAX_EDGES),
  viewStates: z.array(CanvasViewStateSchema).max(50).default([]),
  displayOptions: boundedJson(4096).default({}),
}).superRefine((value, ctx) => {
  if (jsonSize(value) > CANVAS_DOCUMENT_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "Document exceeds size limit" });
  }

  try {
    validateCanvasDocumentEdges(value.nodes, value.edges);
  } catch (err: unknown) {
    ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : "Invalid edges", path: ["edges"] });
  }
});

export const CreateCanvasRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  scopeType: CanvasScopeTypeSchema,
  scopeRef: z.record(z.string(), z.unknown()).nullable(),
  template: z.enum(["blank", "pr_workspace", "project_workspace", "review_loop"]).optional(),
}).superRefine((value, ctx) => {
  if (value.scopeType === "global" && value.scopeRef !== null) {
    ctx.addIssue({ code: "custom", message: "Global scopeRef must be null", path: ["scopeRef"] });
  }
  if (value.scopeType !== "global" && value.scopeRef === null) {
    ctx.addIssue({ code: "custom", message: "Scoped canvases require scopeRef", path: ["scopeRef"] });
  }
});

export const ReplaceCanvasRequestSchema = z.object({
  baseRevision: CanvasRevisionSchema,
  document: CanvasDocumentWriteSchema,
});

export const PatchCanvasNodeRequestSchema = z.object({
  baseRevision: CanvasRevisionSchema,
  updates: z.object({
    position: CanvasPositionSchema.optional(),
    size: CanvasSizeSchema.optional(),
    zIndex: z.number().int().min(-100_000).max(100_000).optional(),
    collapsed: z.boolean().optional(),
    displayState: CanvasDisplayStateSchema.optional(),
    sourceRef: NodeSourceRefSchema.nullable().optional(),
    metadata: boundedJson(CANVAS_NODE_METADATA_MAX_BYTES).optional(),
  }).refine((value) => Object.keys(value).length > 0, { message: "No updates" }),
});

export const CanvasActionTypeSchema = z.enum([
  "terminal.create",
  "terminal.attach",
  "terminal.kill",
  "terminal.observe",
  "terminal.write",
  "terminal.takeover",
  "review.start",
  "review.stop",
  "review.next",
  "review.approve",
  "pr.refresh",
  "file.open",
  "preview.healthCheck",
  "custom.validate",
]);

export const CanvasActionSchema = z.object({
  nodeId: CanvasNodeIdSchema,
  type: CanvasActionTypeSchema,
  payload: boundedJson(64 * 1024).default({}),
}).superRefine((value, ctx) => {
  const payload = value.payload as Record<string, unknown>;
  if (value.type === "terminal.create") {
    if (payload.cwd !== undefined && typeof payload.cwd !== "string") {
      ctx.addIssue({ code: "custom", message: "Invalid terminal cwd", path: ["payload", "cwd"] });
    }
  }
  if (["terminal.attach", "terminal.kill", "terminal.observe", "terminal.write", "terminal.takeover"].includes(value.type)) {
    if (typeof payload.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sessionId)) {
      ctx.addIssue({ code: "custom", message: "Invalid terminal session", path: ["payload", "sessionId"] });
    }
  }
  if (value.type === "terminal.write" && typeof payload.input !== "string") {
    ctx.addIssue({ code: "custom", message: "Invalid terminal input", path: ["payload", "input"] });
  }
  if (value.type === "preview.healthCheck" && (typeof payload.url !== "string" || !safeUrl(payload.url))) {
    ctx.addIssue({ code: "custom", message: "Invalid preview URL", path: ["payload", "url"] });
  }
});

export const CanvasErrorSchema = z.object({
  error: z.string().min(1).max(80).refine((message) => !UNSAFE_CLIENT_ERROR.test(message), {
    message: "Unsafe client error",
  }),
}).strict();

export type CanvasOwnerScope = z.infer<typeof CanvasOwnerScopeSchema>;
export type CanvasScopeType = z.infer<typeof CanvasScopeTypeSchema>;
export type CanvasDocumentWrite = z.infer<typeof CanvasDocumentWriteSchema>;
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
export type CreateCanvasRequest = z.infer<typeof CreateCanvasRequestSchema>;
export type ReplaceCanvasRequest = z.infer<typeof ReplaceCanvasRequestSchema>;
export type CanvasAction = z.infer<typeof CanvasActionSchema>;

const COMPATIBLE_EDGE_TYPES: Record<string, Set<string>> = {
  reviews: new Set(["pr:review_loop", "review_loop:pr", "finding:review_loop", "review_loop:finding"]),
  implements: new Set(["task:pr", "pr:task", "task:project", "project:task"]),
  depends_on: new Set(["task:task", "pr:task", "review_loop:pr"]),
  opens: new Set(["file:preview", "preview:file", "app_window:file"]),
};

export function validateCanvasDocumentEdges(nodes: CanvasNode[], edges: CanvasEdge[]): void {
  const nodeTypes = new Map(nodes.map((node) => [node.id, node.type]));

  for (const edge of edges) {
    const fromType = nodeTypes.get(edge.fromNodeId);
    const toType = nodeTypes.get(edge.toNodeId);
    if (!fromType || !toType) {
      throw new Error("Edge references missing node");
    }
    if (edge.type === "visual" || edge.type === "related") {
      continue;
    }
    const allowed = COMPATIBLE_EDGE_TYPES[edge.type];
    if (!allowed?.has(`${fromType}:${toType}`)) {
      throw new Error("Edge type is not compatible with node types");
    }
  }
}

export function createBlankCanvasDocument(): CanvasDocumentWrite {
  return CanvasDocumentWriteSchema.parse({
    schemaVersion: 1,
    nodes: [],
    edges: [],
    viewStates: [],
    displayOptions: {},
  });
}
