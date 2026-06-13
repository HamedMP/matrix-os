import {
  ChevronRight,
  Home,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  SquareTerminal,
} from "lucide-react";
import { useState } from "react";
import { MatrixMark } from "../../design/BrandPanel";
import { IconButton } from "../../design/primitives";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";

function NavRow({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-100"
      style={{
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "var(--bg-selected)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
      onClick={onClick}
    >
      <span style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {badge ? (
        <span
          className="rounded-full px-1.5 text-xs"
          style={{ background: "var(--highlight-muted)", color: "var(--highlight)" }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-2.5">
      <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
        {label}
      </span>
      {onAdd ? (
        <IconButton label={`New ${label.toLowerCase()}`} onClick={onAdd}>
          <Plus size={13} />
        </IconButton>
      ) : null}
    </div>
  );
}

export default function Sidebar() {
  const tabs = useTabs((s) => s.tabs);
  const activeTabId = useTabs((s) => s.activeTabId);
  const openTab = useTabs((s) => s.openTab);
  const focusTab = useTabs((s) => s.focusTab);
  const projects = useBoard((s) => s.projects);
  const signOut = useConnection((s) => s.signOut);
  const handle = useConnection((s) => s.handle);
  const unread = useThreads((s) => s.threads.filter((t) => t.unread || t.status === "needs-attention").length);
  const [projectsOpen, setProjectsOpen] = useState(true);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const terminalTabs = tabs.filter((t) => t.kind === "terminal");

  return (
    <aside
      className="flex w-[240px] shrink-0 flex-col"
      style={{ background: "var(--bg-sunken)", borderRight: "1px solid var(--border-subtle)" }}
    >
      <div className="titlebar-drag flex items-center gap-2 px-3" style={{ height: "var(--titlebar-height)", paddingLeft: 76 }}>
        <span style={{ color: "var(--accent)" }}>
          <MatrixMark size={20} />
        </span>
        <span className="text-sm font-semibold tracking-tight" style={{ color: "var(--text-primary)" }}>
          Matrix OS
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        <nav className="flex flex-col gap-0.5">
          <NavRow
            icon={<Home size={15} />}
            label="Home"
            active={activeTab?.kind === "home"}
            onClick={() => openTab({ kind: "home", title: "Home", closable: false })}
          />
          <NavRow
            icon={<MessageSquare size={15} />}
            label="Agents"
            active={activeTab?.kind === "agents"}
            badge={unread || undefined}
            onClick={() => openTab({ kind: "agents", title: "Agents" })}
          />
        </nav>

        <SectionHeader
          label="Terminals"
          onAdd={() => openTab({ kind: "home", title: "Home", closable: false })}
        />
        {terminalTabs.length === 0 ? (
          <p className="px-2.5 py-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
            Open a session from a project or Home.
          </p>
        ) : (
          terminalTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-100"
              style={{
                background: tab.id === activeTabId ? "var(--bg-selected)" : "transparent",
                color: "var(--text-secondary)",
              }}
              onMouseEnter={(e) => {
                if (tab.id !== activeTabId) e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                if (tab.id !== activeTabId) e.currentTarget.style.background = "transparent";
              }}
              onClick={() => focusTab(tab.id)}
            >
              <SquareTerminal size={14} style={{ color: "var(--text-tertiary)" }} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{tab.title}</span>
            </button>
          ))
        )}

        <button
          type="button"
          className="mt-4 mb-1 flex w-full items-center gap-1 px-2.5"
          onClick={() => setProjectsOpen((v) => !v)}
        >
          <ChevronRight
            size={12}
            style={{
              color: "var(--text-tertiary)",
              transform: projectsOpen ? "rotate(90deg)" : "none",
              transition: "transform 120ms",
            }}
          />
          <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
            Projects
          </span>
        </button>
        {projectsOpen
          ? projects.map((project) => {
              const isActive = activeTab?.kind === "board" && activeTab.projectSlug === project.slug;
              return (
                <NavRow
                  key={project.slug}
                  icon={<span className="text-xs">▣</span>}
                  label={project.name || project.slug}
                  active={isActive}
                  onClick={() =>
                    openTab({ kind: "board", projectSlug: project.slug, title: project.name || project.slug })
                  }
                />
              );
            })
          : null}
        {projectsOpen && projects.length === 0 ? (
          <p className="px-2.5 py-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
            No projects yet.
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t p-2" style={{ borderColor: "var(--border-subtle)" }}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-100"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          onClick={() => openTab({ kind: "settings", title: "Settings" })}
        >
          <Settings size={15} style={{ color: "var(--text-tertiary)" }} />
          <span className="min-w-0 flex-1 truncate text-left">{handle ? `@${handle}` : "Settings"}</span>
        </button>
        <IconButton
          label="Sign out"
          onClick={() => {
            void signOut().catch((err: unknown) => {
              console.warn(
                "[sidebar] sign-out failed:",
                err instanceof Error ? err.message : String(err),
              );
            });
          }}
        >
          <LogOut size={14} />
        </IconButton>
      </div>
    </aside>
  );
}
