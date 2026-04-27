import { describe, expect, it } from "vitest";
import {
  CanvasActionSchema,
  CanvasDocumentWriteSchema,
  CanvasEdgeSchema,
  CanvasErrorSchema,
  CanvasIdSchema,
  CanvasNodeSchema,
  ReplaceCanvasRequestSchema,
  validateCanvasDocumentEdges,
} from "../../packages/gateway/src/canvas/contracts.js";

const now = "2026-04-27T00:00:00.000Z";

function node(id: string, type = "note") {
  return {
    id,
    type,
    position: { x: 10, y: 20 },
    size: { width: 320, height: 180 },
    zIndex: 0,
    displayState: "normal",
    sourceRef: null,
    metadata: { text: "hello" },
    createdAt: now,
    updatedAt: now,
  };
}

describe("canvas contracts", () => {
  it("accepts stable prefixed IDs and rejects unsafe IDs", () => {
    expect(CanvasIdSchema.parse("cnv_0123456789abcdef")).toBe("cnv_0123456789abcdef");
    expect(() => CanvasIdSchema.parse("../cnv_0123456789abcdef")).toThrow();
    expect(() => CanvasIdSchema.parse("canvas 1")).toThrow();
  });

  it("enforces document, node, and metadata bounds", () => {
    const valid = CanvasDocumentWriteSchema.parse({
      schemaVersion: 1,
      nodes: [node("node_a")],
      edges: [],
      viewStates: [],
      displayOptions: {},
    });
    expect(valid.nodes).toHaveLength(1);

    expect(() =>
      CanvasDocumentWriteSchema.parse({
        schemaVersion: 1,
        nodes: Array.from({ length: 501 }, (_, index) => node(`node_${index}`)),
        edges: [],
        viewStates: [],
        displayOptions: {},
      }),
    ).toThrow();

    expect(() =>
      CanvasNodeSchema.parse({
        ...node("node_large"),
        metadata: { blob: "x".repeat(16 * 1024 + 1) },
      }),
    ).toThrow();
  });

  it("rejects unsafe URLs and file paths in source references", () => {
    expect(() =>
      CanvasNodeSchema.parse({
        ...node("node_url", "preview"),
        sourceRef: { kind: "url", id: "javascript:alert(1)" },
      }),
    ).toThrow();

    expect(() =>
      CanvasNodeSchema.parse({
        ...node("node_file", "file"),
        sourceRef: { kind: "file", id: "../../etc/passwd" },
      }),
    ).toThrow();
  });

  it("rejects stale revisions before repository writes", () => {
    expect(ReplaceCanvasRequestSchema.parse({
      baseRevision: 1,
      document: { schemaVersion: 1, nodes: [], edges: [], viewStates: [], displayOptions: {} },
    }).baseRevision).toBe(1);
    expect(() =>
      ReplaceCanvasRequestSchema.parse({
        baseRevision: 0,
        document: { schemaVersion: 1, nodes: [], edges: [], viewStates: [], displayOptions: {} },
      }),
    ).toThrow();
  });

  it("keeps client-facing error shapes generic", () => {
    expect(CanvasErrorSchema.parse({ error: "Canvas request failed" })).toEqual({
      error: "Canvas request failed",
    });
    expect(() => CanvasErrorSchema.parse({ error: "/home/deploy/secret", issues: [] })).toThrow();
    expect(() => CanvasErrorSchema.parse({ error: "Postgres constraint failed" })).toThrow();
  });

  it("validates edge references and compatible visual edge types", () => {
    const nodes = [node("node_pr", "pr"), node("node_review", "review_loop")];
    const edges = [
      CanvasEdgeSchema.parse({
        id: "edge_1",
        fromNodeId: "node_pr",
        toNodeId: "node_review",
        type: "reviews",
      }),
    ];

    expect(() => validateCanvasDocumentEdges(nodes, edges)).not.toThrow();
    expect(() =>
      validateCanvasDocumentEdges(nodes, [
        { id: "edge_missing", fromNodeId: "node_pr", toNodeId: "node_missing", type: "related" },
      ]),
    ).toThrow();

    expect(() =>
      validateCanvasDocumentEdges(nodes, [
        { id: "edge_bad", fromNodeId: "node_pr", toNodeId: "node_review", type: "implements" },
      ]),
    ).toThrow();
  });

  it("rejects implicit domain mutations through edge metadata", () => {
    expect(() =>
      CanvasEdgeSchema.parse({
        id: "edge_mutation",
        fromNodeId: "node_a",
        toNodeId: "node_b",
        type: "related",
        metadata: { mutateDomain: true },
      }),
    ).toThrow();

    expect(() =>
      CanvasActionSchema.parse({
        nodeId: "node_a",
        type: "task.link",
        payload: { taskId: "task_1" },
      }),
    ).toThrow();
  });

  it("requires HTTPS URLs for server-side preview health checks", () => {
    expect(CanvasActionSchema.safeParse({
      nodeId: "node_a",
      type: "preview.healthCheck",
      payload: { url: "http://example.com" },
    }).success).toBe(false);
    expect(CanvasActionSchema.safeParse({
      nodeId: "node_a",
      type: "preview.healthCheck",
      payload: { url: "https://example.com" },
    }).success).toBe(true);
  });
});
