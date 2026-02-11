export interface ModuleEntry {
  name: string;
  type: string;
  path: string;
  port: number;
  status: "running" | "stopped" | "error";
  createdAt: string;
  dependencies?: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  color: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const STATUS_COLORS: Record<string, string> = {
  running: "#64ffda",
  stopped: "#666",
  error: "#ff5252",
};

export function modulesToGraph(modules: ModuleEntry[]): GraphData {
  const nodes: GraphNode[] = modules.map((m) => ({
    id: m.name,
    label: m.name,
    color: STATUS_COLORS[m.status] ?? "#999",
  }));

  const edges: GraphEdge[] = modules.flatMap((m) =>
    (m.dependencies ?? []).map((dep) => ({
      from: m.name,
      to: dep,
    })),
  );

  return { nodes, edges };
}
