import {
  Check,
  Filter,
  FolderKanban,
  MessageCircle,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openCodingAgentThread } from "../../lib/project-chat";
import {
  useTabs,
  type RecentView,
  type RecentViewFilter,
} from "../../stores/tabs";
import { useConnection } from "../../stores/connection";
import { useHermesChat } from "../../stores/hermes-chat";
import { useThreads } from "../../stores/threads";

const FILTER_OPTIONS: Array<{ filter: RecentViewFilter; label: string }> = [
  { filter: "all", label: "All recents" },
  { filter: "conversation", label: "Conversations" },
  { filter: "terminal", label: "Terminals" },
  { filter: "project", label: "Projects" },
];

function RecentIcon({ kind }: { kind: RecentView["kind"] }) {
  if (kind === "conversation") return <MessageCircle size={13} />;
  if (kind === "terminal") return <SquareTerminal size={13} />;
  return <FolderKanban size={13} />;
}

export default function RecentViews() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const recentViews = useTabs((state) => state.recentViews);
  const recentFilter = useTabs((state) => state.recentFilter);
  const setRecentFilter = useTabs((state) => state.setRecentFilter);
  const tabs = useTabs((state) => state.tabs);
  const openTab = useTabs((state) => state.openTab);
  const requestTerminalSession = useTabs((state) => state.requestTerminalSession);
  const api = useConnection((state) => state.api);
  const threads = useThreads((state) => state.threads);
  const setActiveThread = useThreads((state) => state.setActiveThread);
  const openHermesConversation = useHermesChat((state) => state.openConversation);
  const showHermesIndex = useHermesChat((state) => state.showIndex);
  const visible = useMemo(
    () => recentViews.filter((recent) => recentFilter === "all" || recent.kind === recentFilter).slice(0, 8),
    [recentFilter, recentViews],
  );

  useEffect(() => {
    if (!filterOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterOpen]);

  const openRecent = (recent: RecentView) => {
    if (recent.kind === "project") {
      openTab({ kind: "project", projectSlug: recent.id, title: recent.label });
      return;
    }
    if (recent.kind === "terminal") {
      const terminalsWorkspace = tabs.find((tab) => tab.kind === "terminals");
      if (terminalsWorkspace) {
        requestTerminalSession(recent.id);
        openTab({ kind: "terminals", title: terminalsWorkspace.title });
        return;
      }
      const nativeTab = tabs.find((tab) => tab.kind === "terminal" && tab.sessionName === recent.id);
      if (nativeTab) {
        openTab({ kind: "terminal", sessionName: recent.id, title: recent.label });
        return;
      }
      openTab({ kind: "terminal", sessionName: recent.id, title: recent.label });
      return;
    }
    const legacyThread = threads.find((candidate) => candidate.id === recent.id);
    if (recent.conversationType === "coding-agent") {
      void openCodingAgentThread(recent.id);
      return;
    }
    if (legacyThread) {
      setActiveThread(legacyThread.id);
      openTab({ kind: "chat", title: "Hermes", closable: false });
      return;
    }
    setActiveThread(null);
    openTab({ kind: "chat", title: "Hermes", closable: false });
    if (api) {
      void openHermesConversation(api, recent.id);
    } else {
      showHermesIndex();
    }
  };

  return (
    <div ref={rootRef} className="relative mt-4">
      <div className="flex items-center justify-between px-2.5 pb-1">
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: "var(--text-tertiary)" }}>
          Recents
        </span>
        <button
          type="button"
          aria-label="Filter recents"
          aria-haspopup="menu"
          aria-expanded={filterOpen}
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--bg-hover)]"
          style={{ color: recentFilter === "all" ? "var(--text-tertiary)" : "var(--accent)" }}
          onClick={() => setFilterOpen((value) => !value)}
        >
          <Filter size={12} />
        </button>
      </div>

      {filterOpen ? (
        <div
          role="menu"
          aria-label="Recent type"
          className="absolute right-1 top-6 z-20 w-40 rounded-lg border p-1 shadow-lg"
          style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)" }}
        >
          {FILTER_OPTIONS.map((option) => (
            <button
              key={option.filter}
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-primary)" }}
              onClick={() => {
                setRecentFilter(option.filter);
                setFilterOpen(false);
              }}
            >
              <span className="flex w-3 items-center justify-center">
                {recentFilter === option.filter ? <Check size={12} /> : null}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-0.5">
        {visible.map((recent) => (
          <button
            key={`${recent.kind}:${recent.id}`}
            type="button"
            aria-label={`Open recent ${recent.label}`}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => openRecent(recent)}
          >
            <span className="shrink-0" style={{ color: "var(--text-tertiary)" }}><RecentIcon kind={recent.kind} /></span>
            <span className="min-w-0 flex-1 truncate">{recent.label}</span>
          </button>
        ))}
        {visible.length === 0 ? (
          <span className="px-2.5 py-1 text-xs" style={{ color: "var(--text-tertiary)" }}>
            No recent {recentFilter === "all" ? "views" : FILTER_OPTIONS.find((option) => option.filter === recentFilter)?.label.toLowerCase()}.
          </span>
        ) : null}
      </div>
    </div>
  );
}
