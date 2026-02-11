import { describe, it, expect } from "vitest";
import {
  modulesToGraph,
  type ModuleEntry,
  type GraphData,
} from "../../shell/src/lib/moduleGraph.js";

const sampleModules: ModuleEntry[] = [
  {
    name: "expense-tracker",
    type: "module",
    path: "~/modules/expense-tracker/",
    port: 3100,
    status: "running",
    createdAt: "2026-02-11T10:00:00Z",
  },
  {
    name: "expense-cli",
    type: "module",
    path: "~/modules/expense-cli/",
    port: 3101,
    status: "running",
    createdAt: "2026-02-11T10:05:00Z",
    dependencies: ["expense-tracker"],
  },
  {
    name: "dashboard",
    type: "module",
    path: "~/modules/dashboard/",
    port: 3102,
    status: "stopped",
    createdAt: "2026-02-11T10:10:00Z",
    dependencies: ["expense-tracker"],
  },
];

describe("modulesToGraph", () => {
  it("returns empty graph for empty modules", () => {
    const result = modulesToGraph([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("creates a node for each module", () => {
    const result = modulesToGraph(sampleModules);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.map((n) => n.id)).toEqual([
      "expense-tracker",
      "expense-cli",
      "dashboard",
    ]);
  });

  it("sets node labels to module names", () => {
    const result = modulesToGraph(sampleModules);
    expect(result.nodes[0].label).toBe("expense-tracker");
    expect(result.nodes[1].label).toBe("expense-cli");
  });

  it("creates edges from dependencies", () => {
    const result = modulesToGraph(sampleModules);
    expect(result.edges).toHaveLength(2);
    expect(result.edges).toContainEqual({
      from: "expense-cli",
      to: "expense-tracker",
    });
    expect(result.edges).toContainEqual({
      from: "dashboard",
      to: "expense-tracker",
    });
  });

  it("distinguishes running vs stopped modules", () => {
    const result = modulesToGraph(sampleModules);
    const running = result.nodes.find((n) => n.id === "expense-tracker");
    const stopped = result.nodes.find((n) => n.id === "dashboard");
    expect(running?.color).not.toBe(stopped?.color);
  });

  it("handles modules with no dependencies", () => {
    const result = modulesToGraph([sampleModules[0]]);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });
});
