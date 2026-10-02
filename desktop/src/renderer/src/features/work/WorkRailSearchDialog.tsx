import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { Folder, MessageSquare, Search, UsersIcon, X } from "@renderer/lib/hugeicons";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../../design/primitives";
import type { Project } from "../../stores/board";
import { useTabs } from "../../stores/tabs";
import { sharedItemContext, sharedItemLabel, useWorkSharedDiscovery } from "./use-work-shared-discovery";
import { buildWorkRailSearchResults } from "./work-rail-model";

export function WorkRailSearchDialog({
  open,
  records,
  projects,
  status,
  onClose,
  onSelect,
  onSelectProject,
}: {
  open: boolean;
  records: readonly CanonicalChatRecord[];
  projects: readonly Project[];
  status: "idle" | "loading" | "ready" | "error";
  onClose: () => void;
  onSelect: (record: CanonicalChatRecord, project?: Project) => void;
  onSelectProject?: (project: Project) => void;
}) {
  const [filter, setFilter] = useState<"All" | "Chats" | "Projects" | "Shared">("All");
  const shared = useWorkSharedDiscovery(open);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const chats = filter === "All" || filter === "Chats"
      ? buildWorkRailSearchResults(records, projects, query).map(result => ({ kind: "chat" as const, ...result, label: result.record.chat.title, key: `chat:${result.record.chat.id}` })) : [];
    const projectResults = (filter === "All" || filter === "Projects") && onSelectProject
      ? projects.filter(project => !normalized || `${project.name}
${project.slug}`.toLocaleLowerCase().includes(normalized)).map(project => ({ kind: "project" as const, project, label: project.name, contextLabel: "Project", key: `project:${project.id ?? project.slug}` })) : [];
    const sharedResults = filter === "All" || filter === "Shared"
      ? shared.items.filter(item => !normalized || `${sharedItemLabel(item)}
${sharedItemContext(item)}`.toLocaleLowerCase().includes(normalized)).map(item => ({ kind: "shared" as const, item, label: sharedItemLabel(item), contextLabel: sharedItemContext(item), key: item.status === "invited" ? `invite:${item.invitationId}` : `shared:${item.scopeId}` })) : [];
    return [...chats, ...projectResults, ...sharedResults].slice(0, 50);
  }, [filter, projects, query, records, shared.items, onSelectProject]);
  useEffect(() => {
    setSelectedIndex((current) => (
      results.length === 0 ? 0 : Math.min(current, results.length - 1)
    ));
  }, [results.length]);
  useEffect(() => {
    if (!open) return;
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, results, selectedIndex]);

  const close = () => {
    setQuery("");
    setFilter("All");
    setSelectedIndex(0);
    onClose();
  };
  const select = (index: number) => {
    const result = results[index];
    if (!result) return;
    if (result.kind === "chat") onSelect(result.record, result.project);
    else if (result.kind === "project") onSelectProject?.(result.project);
    else { useTabs.getState().openTab({ kind: "shared", title: "Shared with me" }); onClose(); }
    setQuery("");
    setSelectedIndex(0);
  };
  const updateQuery = (next: string) => {
    setQuery(next);
    setSelectedIndex(0);
  };
  const moveSelection = (offset: number) => {
    if (results.length === 0) return;
    setSelectedIndex((current) => (current + offset + results.length) % results.length);
  };

  return (
    <Dialog open={open} onClose={close} width={620} title="Search chats" top="12vh">
      <div className="p-3">
        <div className="chat-search-field flex h-10 items-center gap-2 rounded-lg border px-3" style={{ borderColor: "var(--border-default)" }}>
          <Search size={16} aria-hidden style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={searchInputRef}
            type="text"
            role="searchbox"
            aria-label="Search chats"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-activedescendant={results[selectedIndex]
              ? `${listboxId}-option-${selectedIndex}`
              : undefined}
            autoFocus
            value={query}
            className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-sm shadow-none outline-none ring-0 focus:border-0 focus:ring-0"
            style={{
              appearance: "none",
              WebkitAppearance: "none",
              borderStyle: "none",
              borderWidth: 0,
              borderRadius: 0,
              boxShadow: "none",
              outline: "none",
              color: "var(--text-primary)",
            }}
            placeholder="Search chats"
            onChange={(event) => updateQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                select(selectedIndex);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <button
            type="button"
            aria-label="Clear Chat search"
            title="Clear Chat search"
            className="flex size-7 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)]"
            onClick={() => {
              updateQuery("");
              searchInputRef.current?.focus();
            }}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div role="tablist" aria-label="Search scope" className="mt-3 flex gap-1.5 px-1">
          {(["All", "Chats", "Projects", "Shared"] as const).map(scope => <button key={scope} type="button" role="tab" aria-selected={filter === scope} disabled={scope === "Shared" && !shared.available || scope === "Projects" && !onSelectProject}
            className="rounded-full px-3 py-1 text-xs outline-none hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--text-primary)] aria-selected:text-[var(--bg-surface)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
            onClick={() => { setFilter(scope); setSelectedIndex(0); }}>{scope}</button>)}
        </div>
        <div className="mt-2 max-h-[min(480px,60vh)] overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
          {filter !== "Shared" && status === "loading" && records.length === 0 ? (
            <p role="status" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading chats…</p>
          ) : null}
          {filter !== "Shared" && status === "error" && records.length === 0 ? (
            <p role="alert" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-secondary)" }}>Chats could not be loaded.</p>
          ) : null}
          {filter !== "Shared" && status === "error" && records.length > 0 ? (
            <p role="status" className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
              Showing recently loaded chats. Refresh failed.
            </p>
          ) : null}
          {filter === "All" && status !== "loading" && status !== "error" && records.length === 0 && results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats yet.</p>
          ) : null}
          {records.length > 0 && results.length === 0 && filter !== "Shared" ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats found.</p>
          ) : null}
          {filter === "Shared" && shared.loading ? <p role="status" className="px-3 py-8 text-center text-sm">Loading shared items…</p> : null}
          {filter === "Shared" && shared.error ? <p role="alert" className="px-3 py-8 text-center text-sm">{shared.error}</p> : null}
          {filter === "Shared" && !shared.loading && !shared.error && results.length === 0 ? <p className="px-3 py-8 text-center text-sm">No shared items found.</p> : null}
          {filter === "Projects" && results.length === 0 ? <p className="px-3 py-8 text-center text-sm">No projects found.</p> : null}
          {results.length > 0 ? (
            <div id={listboxId} role="listbox" aria-label={query ? "Chat search results" : "Recent chats"}>
              {results.map((result, index) => (
                <button
                  key={result.key}
                  id={`${listboxId}-option-${index}`}
                  ref={(node) => { optionRefs.current[index] = node; }}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-label={`${result.label}, ${result.contextLabel}`}
                  aria-selected={index === selectedIndex}
                  className="flex w-full min-w-0 items-center gap-3 border-b px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                  style={{ borderColor: "var(--border-subtle)" }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => select(index)}
                >
                  {result.kind === "project" ? <Folder size={15} aria-hidden className="shrink-0" /> : result.kind === "shared" ? <UsersIcon size={15} aria-hidden className="shrink-0" /> : <MessageSquare size={15} aria-hidden className="shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" style={{ color: "var(--text-primary)" }}>{result.label}</span>
                    <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{result.contextLabel}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
