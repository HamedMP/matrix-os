import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import { Button, ContextMenu } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

export default function Titlebar() {
  const projects = useBoard((s) => s.projects);
  const activeSlug = useBoard((s) => s.activeProjectSlug);
  const selectProject = useBoard((s) => s.selectProject);
  const api = useConnection((s) => s.api);
  const handle = useConnection((s) => s.handle);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const setCreateTaskOpen = useUi((s) => s.setCreateTaskOpen);
  const navigate = useUi((s) => s.navigate);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const activeProject = projects.find((p) => p.slug === activeSlug);

  return (
    <header
      className="titlebar-drag flex shrink-0 items-center gap-2 border-b pl-[84px] pr-3"
      style={{
        height: "var(--titlebar-height)",
        borderColor: "var(--border-subtle)",
        background: "var(--bg-surface)",
      }}
    >
      <button
        type="button"
        className="no-drag flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-colors duration-100"
        style={{ color: "var(--text-primary)" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenuPos({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        {activeProject?.name ?? activeProject?.slug ?? "Select project"}
        <ChevronDown size={13} style={{ color: "var(--text-tertiary)" }} />
      </button>
      <ContextMenu
        position={menuPos}
        onClose={() => setMenuPos(null)}
        items={projects.map((p) => ({
          label: p.name || p.slug,
          onSelect: () => {
            if (api) {
              void selectProject(api, p.slug);
              navigate({ kind: "board" });
            }
          },
        }))}
      />

      <div className="flex-1" />

      <span
        className="rounded-full border px-2 py-0.5 text-xs"
        style={{ borderColor: "var(--border-default)", color: "var(--text-tertiary)" }}
        title="Active runtime"
      >
        {runtimeSlot}
      </span>
      {handle ? (
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          @{handle}
        </span>
      ) : null}
      <Button variant="primary" onClick={() => setCreateTaskOpen(true)} title="New task (C)">
        <Plus size={14} />
        New task
      </Button>
    </header>
  );
}
