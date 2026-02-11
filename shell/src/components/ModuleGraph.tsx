"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useFileWatcherPattern } from "@/hooks/useFileWatcher";
import { modulesToGraph, type ModuleEntry } from "@/lib/moduleGraph";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

export function ModuleGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<unknown>(null);
  const [modules, setModules] = useState<ModuleEntry[]>([]);

  const fetchModules = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/files/system/modules.json`);
      if (res.ok) {
        const data = await res.json();
        setModules(Array.isArray(data) ? data : []);
      }
    } catch {
      // gateway not available
    }
  }, []);

  useEffect(() => {
    fetchModules();
  }, [fetchModules]);

  useFileWatcherPattern(
    /^system\/modules\.json$/,
    useCallback(() => {
      fetchModules();
    }, [fetchModules]),
  );

  useEffect(() => {
    if (!containerRef.current) return;

    async function render() {
      const { Network } = await import("vis-network");
      const { DataSet } = await import("vis-data");

      if (!containerRef.current) return;

      const graphData = modulesToGraph(modules);

      const nodes = new DataSet(
        graphData.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          color: {
            background: n.color,
            border: n.color,
            highlight: { background: n.color, border: "#fff" },
          },
          font: { color: "#e0e0e0", size: 12 },
          shape: "dot",
          size: 20,
        })),
      );

      const edges = new DataSet(
        graphData.edges.map((e, i) => ({
          id: `edge-${i}`,
          from: e.from,
          to: e.to,
          arrows: "to",
          color: { color: "#555", highlight: "#aaa" },
        })),
      );

      if (networkRef.current) {
        (networkRef.current as { destroy: () => void }).destroy();
      }

      networkRef.current = new Network(
        containerRef.current!,
        { nodes, edges },
        {
          physics: {
            solver: "forceAtlas2Based",
            stabilization: { iterations: 50 },
          },
          interaction: {
            hover: true,
            zoomView: true,
            dragView: true,
          },
          layout: {
            improvedLayout: true,
          },
        },
      );
    }

    render();

    return () => {
      if (networkRef.current) {
        (networkRef.current as { destroy: () => void }).destroy();
        networkRef.current = null;
      }
    };
  }, [modules]);

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b text-xs select-none"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <span className="font-medium">Module Graph</span>
        <span className="text-xs" style={{ color: "var(--color-muted)" }}>
          {modules.length} modules
        </span>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ background: "var(--color-bg)" }}
      />
    </div>
  );
}
