import type { ChatNavigationRecord } from "@matrix-os/ui";
import { isAcceptedProjectOwnedByRail } from "@matrix-os/ui";
import { Folder, MessageSquare, Search, UsersIcon, X } from "@renderer/lib/hugeicons";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import type { Project } from "../../stores/board";
import { sharedItemContext, sharedItemLabel, useWorkSharedDiscovery } from "./use-work-shared-discovery";
import { buildWorkRailSearchResults } from "./work-rail-model";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { canonicalChatRequestId } from "../chat/canonical-chat-submission";

export function WorkRailSearchDialog({
  open,
  records,
  client,
  projects,
  status,
  onClose,
  onSelect,
  onSelectProject,
  onOpenShared,
  onArchiveChanged,
}: {
  open: boolean;
  records: readonly ChatNavigationRecord[];
  client?: CanonicalChatClient | null;
  projects: readonly Project[];
  status: "idle" | "loading" | "ready" | "error";
  onClose: () => void;
  onSelect: (record: ChatNavigationRecord, project?: Project) => void;
  onSelectProject?: (project: Project) => void;
  onOpenShared?: () => void;
  onArchiveChanged?: () => void;
}) {
  const [filter, setFilter] = useState<"All" | "Chats" | "Projects" | "Shared" | "Archived">("All");
  const organizationStatus = useConnection(state => state.organizationStatus);
  const activeFilter = organizationStatus === "none" && filter === "Shared" ? "All" : filter;
  const shared = useWorkSharedDiscovery(open && organizationStatus !== "none");
  const [query, setQuery] = useState("");
  const [serverRecords, setServerRecords] = useState<ChatNavigationRecord[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedArchivedIds, setSelectedArchivedIds] = useState<string[]>([]);
  const [archiveActionBusy, setArchiveActionBusy] = useState(false);
  const [archiveActionError, setArchiveActionError] = useState<string | null>(null);
  const [confirmArchiveDelete, setConfirmArchiveDelete] = useState(false);
  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!open || !client || (activeFilter !== "Archived" && (!query.trim() || activeFilter === "Projects" || activeFilter === "Shared"))) {
      setServerRecords(null);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setServerRecords(null);
    setSearchLoading(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      const request = activeFilter === "Archived" && !query.trim()
        ? client.list({ lifecycle: "archived", limit: 50 })
        : client.search(query, { lifecycle: activeFilter === "Archived" ? "archived" : "active", limit: 50 });
      void request.then(page => {
        if (!cancelled) setServerRecords(page.items);
      }).catch((error: unknown) => {
        console.warn("[work] Chat search failed:", error instanceof Error ? error.name : "UnknownError");
        if (!cancelled) setSearchError("Chats could not be searched. Try again.");
      }).finally(() => { if (!cancelled) setSearchLoading(false); });
    }, query.trim() ? 180 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, client, activeFilter, query]);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const searchSource = activeFilter === "Archived" || normalized ? (serverRecords ?? []) : records;
    const chats = activeFilter === "All" || activeFilter === "Chats" || activeFilter === "Archived"
      ? buildWorkRailSearchResults(searchSource, projects, serverRecords ? "" : query).map(result => ({ kind: "chat" as const, ...result, label: result.record.chat.title, key: `chat:${result.record.chat.id}` })) : [];
    const projectResults = (activeFilter === "All" || activeFilter === "Projects") && onSelectProject
      ? projects.filter(project => !normalized || `${project.name}
${project.slug}`.toLocaleLowerCase().includes(normalized)).map(project => ({ kind: "project" as const, project, label: project.name, contextLabel: "Project", key: `project:${project.id ?? project.slug}` })) : [];
    const sharedResults = activeFilter === "All" || activeFilter === "Shared"
      ? shared.items.filter(item => !isAcceptedProjectOwnedByRail(item))
        .filter(item => !normalized || `${sharedItemLabel(item)}
${sharedItemContext(item)}`.toLocaleLowerCase().includes(normalized)).map(item => ({ kind: "shared" as const, item, label: sharedItemLabel(item), contextLabel: sharedItemContext(item), key: item.status === "invited" ? `invite:${item.invitationId}` : `shared:${item.scopeId}` })) : [];
    return [...chats, ...projectResults, ...sharedResults].slice(0, 50);
  }, [activeFilter, projects, query, records, serverRecords, shared.items, onSelectProject]);
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
    setSelectedArchivedIds([]);
    setConfirmArchiveDelete(false);
    onClose();
  };
  const select = (index: number) => {
    const result = results[index];
    if (!result) return;
    if (result.kind === "chat") onSelect(result.record, result.project);
    else if (result.kind === "project") onSelectProject?.(result.project);
    else { onOpenShared?.(); onClose(); }
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
  const applyArchivedAction = async (action: "restore" | "delete") => {
    if (!client || archiveActionBusy || selectedArchivedIds.length === 0) return;
    const targets = (serverRecords ?? []).filter(record => selectedArchivedIds.includes(record.chat.id));
    const completed: string[] = [];
    setArchiveActionBusy(true);
    setArchiveActionError(null);
    try {
      for (const record of targets) {
        if (action === "restore") await client.updateLifecycle(record.chat.id, { baseRevision: record.chat.revision, lifecycle: "active" });
        else await client.delete(record.chat.id, canonicalChatRequestId());
        completed.push(record.chat.id);
      }
      setConfirmArchiveDelete(false);
    } catch (error: unknown) {
      console.warn("[work] Archived chat action failed:", error instanceof Error ? error.name : "UnknownError");
      setArchiveActionError(action === "restore" ? "Some chats could not be restored. Try again." : "Some chats could not be deleted. Try again.");
    } finally {
      setServerRecords(current => current?.filter(record => !completed.includes(record.chat.id)) ?? null);
      setSelectedArchivedIds(current => current.filter(id => !completed.includes(id)));
      if (completed.length) onArchiveChanged?.();
      setArchiveActionBusy(false);
    }
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
          {(["All", "Chats", "Projects", "Archived", "Shared"] as const).filter(scope => organizationStatus !== "none" || scope !== "Shared").map(scope => <button key={scope} type="button" role="tab" aria-selected={activeFilter === scope} disabled={scope === "Shared" && !shared.available || scope === "Projects" && !onSelectProject}
            className="rounded-full px-3 py-1 text-xs outline-none hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--text-primary)] aria-selected:text-[var(--bg-surface)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
            onClick={() => { setFilter(scope); setSelectedIndex(0); setSelectedArchivedIds([]); setConfirmArchiveDelete(false); }}>{scope}</button>)}
        </div>
        {activeFilter === "Archived" && selectedArchivedIds.length > 0 ? <div className="mt-2 flex items-center gap-2 px-1 text-xs">
          <span>{selectedArchivedIds.length} selected</span>
          <button type="button" disabled={archiveActionBusy} className="rounded border px-2 py-1" onClick={() => { void applyArchivedAction("restore"); }}>Restore selected</button>
          <button type="button" disabled={archiveActionBusy} className="rounded border px-2 py-1" onClick={() => setConfirmArchiveDelete(true)}>Delete selected</button>
        </div> : null}
        {archiveActionError ? <p role="alert" className="mt-2 px-1 text-xs" style={{ color: "var(--danger)" }}>{archiveActionError}</p> : null}
        {confirmArchiveDelete ? <div role="alertdialog" aria-label="Delete archived chats?" className="mt-2 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--danger)" }}>
          <p>This permanently deletes the selected chats and their messages. This action cannot be undone.</p>
          <div className="mt-2 flex justify-end gap-2"><button type="button" disabled={archiveActionBusy} onClick={() => setConfirmArchiveDelete(false)}>Cancel</button>
            <button type="button" disabled={archiveActionBusy} className="font-semibold" style={{ color: "var(--danger)" }} onClick={() => { void applyArchivedAction("delete"); }}>Delete permanently</button></div>
        </div> : null}
        <div className="mt-2 max-h-[min(480px,60vh)] overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
          {searchLoading ? <p role="status" className="px-3 py-2 text-xs">Searching all chats…</p> : null}
          {searchError ? <p role="alert" className="px-3 py-2 text-xs">{searchError}</p> : null}
          {activeFilter !== "Shared" && status === "loading" && records.length === 0 ? (
            <p role="status" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading chats…</p>
          ) : null}
          {activeFilter !== "Shared" && status === "error" && records.length === 0 ? (
            <p role="alert" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-secondary)" }}>Chats could not be loaded.</p>
          ) : null}
          {activeFilter !== "Shared" && status === "error" && records.length > 0 ? (
            <p role="status" className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
              Showing recently loaded chats. Refresh failed.
            </p>
          ) : null}
          {activeFilter === "All" && status !== "loading" && status !== "error" && records.length === 0 && results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats yet.</p>
          ) : null}
          {records.length > 0 && results.length === 0 && activeFilter !== "Shared" ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats found.</p>
          ) : null}
          {activeFilter === "Shared" && shared.loading ? <p role="status" className="px-3 py-8 text-center text-sm">Loading shared items…</p> : null}
          {activeFilter === "Shared" && shared.error ? <p role="alert" className="px-3 py-8 text-center text-sm">{shared.error}</p> : null}
          {activeFilter === "Shared" && !shared.loading && !shared.error && results.length === 0 ? <p className="px-3 py-8 text-center text-sm">No shared items found.</p> : null}
          {activeFilter === "Projects" && results.length === 0 ? <p className="px-3 py-8 text-center text-sm">No projects found.</p> : null}
          {results.length > 0 ? (
            <div id={listboxId} role="listbox" aria-label={query ? "Chat search results" : "Recent chats"}>
              {results.map((result, index) => (
                <div key={result.key} className="flex items-center">
                {activeFilter === "Archived" && result.kind === "chat" ? <input type="checkbox" aria-label={`Select ${result.label}`} className="ml-3" checked={selectedArchivedIds.includes(result.record.chat.id)} disabled={archiveActionBusy}
                  onChange={event => setSelectedArchivedIds(current => event.target.checked ? [...current, result.record.chat.id] : current.filter(id => id !== result.record.chat.id))} /> : null}
                <button
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
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
