"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  CornerDownLeft,
  Folder,
  MessageSquare,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { CanonicalChatListResponse, CanonicalChatRecord } from "@matrix-os/contracts";
import { type ChatArchiveClient, type ChatNavigationRecord } from "@matrix-os/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import type { WebProject } from "./web-projects";

type Scope = "All" | "Chats" | "Projects" | "Archived" | "Shared";
type SearchChats = (
  query: string,
  input?: {
    lifecycle?: "active" | "archived";
    limit?: number;
    cursor?: string;
  },
) => Promise<CanonicalChatListResponse>;
export function WebChatSearchDialog({
  client,
  search,
  recent,
  projects,
  centerX,
  bounds,
  onClose,
  onSelect,
  onProject,
  onShared,
  onOpenArchived,
  onRestored,
}: {
  client?: ChatArchiveClient;
  search?: SearchChats;
  recent: readonly ChatNavigationRecord[];
  projects: readonly WebProject[];
  centerX?: number;
  bounds?: {left:number;right:number};
  onClose(): void;
  onSelect(id: string): void;
  onProject(project: WebProject): void;
  onShared?(): void;
  onOpenArchived(): void;
  onRestored?(record: CanonicalChatRecord): void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("All");
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState<{
    rows: CanonicalChatRecord[];
    cursor?: string;
    loading: boolean;
    error: boolean;
  }>({ rows: [], loading: false, error: false });
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState(false);
  const [deletion, setDeletion] = useState<ChatNavigationRecord | null>(null);
  const generation = useRef(0),
    removed = useRef<string[]>([]),
    alive = useRef(true);
  const listId = useId();
  const phrase = query.trim();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    setIndex(0);
    setDeletion(null);
    setError(false);
    const requestsChats = scope !== "Projects" && scope !== "Shared" && Boolean(phrase || scope === "Archived");
    setPage({
      rows: [],
      loading: requestsChats,
      error: false,
    });
    if (!requestsChats) return;
    const timer = window.setTimeout(
      () => {
        const request =
          scope === "Archived" && !phrase
            ? client?.list({ lifecycle: "archived", limit: 50 })
            : search?.(phrase, {
                lifecycle: scope === "Archived" ? "archived" : "active",
                limit: 50,
              });
        if (!request) {
          setPage({ rows: [], loading: false, error: true });
          return;
        }
        void request
          .then((value) => {
            if (generation.current === current)
              setPage({
                rows: value.items.filter((row) => !removed.current.includes(row.chat.id)).slice(0, 500),
                cursor: value.nextCursor,
                loading: false,
                error: false,
              });
          })
          .catch((cause: unknown) => {
            console.warn("[chat-search] Search unavailable:", cause instanceof Error ? cause.name : "UnknownError");
            if (generation.current === current) setPage({ rows: [], loading: false, error: true });
          });
      },
      phrase ? 180 : 0,
    );
    return () => {
      generation.current++;
      window.clearTimeout(timer);
    };
  }, [client, search, phrase, scope]);
  const records =
    scope === "Archived"
      ? page.rows
      : phrase && search
        ? page.rows
        : recent.filter((row) => !phrase || `${row.chat.title} ${""}`.toLowerCase().includes(phrase.toLowerCase()));
  const rows = useMemo(
    () =>
      [
        ...(scope === "All" || scope === "Chats" || scope === "Archived"
          ? records.map((record) => ({
              key: record.chat.id,
              label: record.chat.title,
              record,
              project: undefined as WebProject | undefined,
            }))
          : []),
        ...(scope === "All" || scope === "Projects"
          ? projects
              .filter(
                (project) => !phrase || `${project.name} ${project.slug}`.toLowerCase().includes(phrase.toLowerCase()),
              )
              .map((project) => ({
                key: `project:${project.id}`,
                label: project.name,
                project,
                record: undefined,
              }))
          : []),
      ].slice(0, 500),
    [scope, records, projects, phrase],
  );
  const select = (position: number) => {
    const row = rows[position];
    if (!row) return;
    if (scope === "Archived") onOpenArchived();
    else if (row.record) onSelect(row.record.chat.id);
    else if (row.project) onProject(row.project);
    onClose();
  };
  const apply = (action: "restore" | "delete", record: ChatNavigationRecord) => {
    if (!client || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    const current = generation.current;
    const request =
      action === "restore"
        ? client.updateLifecycle(record.chat.id, {
            baseRevision: record.chat.revision,
            lifecycle: "active",
          })
        : client.delete(record.chat.id, `req_${crypto.randomUUID().replaceAll("-", "")}`);
    return request
      .then((restored) => {
        if (!alive.current) return;
        removed.current = [...removed.current.slice(-499), record.chat.id];
        setPage((value) => ({
          ...value,
          rows: value.rows.filter((row) => row.chat.id !== record.chat.id),
        }));
        setDeletion(null);
        if (action === "restore") onRestored?.(restored as CanonicalChatRecord);
      })
      .catch((cause: unknown) => {
        console.warn("[chat-search] Archive action failed:", cause instanceof Error ? cause.name : "UnknownError");
        if (alive.current && current === generation.current) setError(true);
      })
      .finally(() => {
        lock.current = false;
        if (alive.current) setBusy(false);
      });
  };
  const more = () => {
    if (!page.cursor || page.loading) return;
    const current = generation.current;
    setPage((value) => ({ ...value, loading: true, error: false }));
    const input = {
      lifecycle: scope === "Archived" ? ("archived" as const) : ("active" as const),
      limit: 50,
      cursor: page.cursor,
    };
    const request = phrase ? search?.(phrase, input) : client?.list({ ...input, lifecycle: "archived" });
    if (!request) {
      setPage((value) => ({ ...value, loading: false, error: true }));
      return;
    }
    return request
      .then((value) => {
        if (current !== generation.current) return;
        setPage((previous) => ({
          ...previous,
          rows: [
            ...previous.rows,
            ...value.items.filter(
              (row) =>
                !previous.rows.some((item) => item.chat.id === row.chat.id) && !removed.current.includes(row.chat.id),
            ),
          ].slice(-500),
          cursor: value.nextCursor,
          loading: false,
        }));
      })
      .catch((cause: unknown) => {
        console.warn("[chat-search] Search page failed:", cause instanceof Error ? cause.name : "UnknownError");
        if (current === generation.current) setPage((value) => ({ ...value, loading: false, error: true }));
      });
  };
  const dialogWidth = bounds ? Math.max(0, Math.min(600, bounds.right - bounds.left - 32)) : 600;
  const fittedCenter = bounds && centerX !== undefined ? Math.max(bounds.left + 16 + dialogWidth / 2, Math.min(bounds.right - 16 - dialogWidth / 2, centerX)) : centerX;
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          aria-label="Search chats"
          showCloseButton={false}
          className="desktop-chat-design chat-search-design gap-0 p-0 sm:max-w-[600px]"
          style={{
            zIndex: SHELL_Z_INDEX.appDialog,
            top: "min(128px, 14vh)",
            translate: "none",
            left: fittedCenter === undefined ? "50%" : fittedCenter,
            width: dialogWidth,
            transform: "translateX(-50%)",
          }}
          overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Search chats</DialogTitle>
            <DialogDescription>Search your chats, projects, and archived history.</DialogDescription>
          </DialogHeader>
          <div className="flex h-14 items-center gap-3 border-b px-4">
            <Search size={20} className="shrink-0 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              role="combobox"
              aria-label="Search chats"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={rows[index] ? `${listId}-${index}` : undefined}
              placeholder="Search"
              maxLength={200}
              value={query}
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setIndex(
                    (value) => (value + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % Math.max(rows.length, 1),
                  );
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  select(index);
                }
                if (scope === "Archived" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
                  event.preventDefault();
                  const row = rows[index];
                  if (row?.record) void apply("restore", row.record);
                }
              }}
            />
            <button type="button" aria-label="Close search" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          <div role="tablist" aria-label="Search scope" className="chat-search-filters">
            {(["All", "Chats", "Projects", "Archived", ...(onShared ? ["Shared"] : [])] as Scope[]).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                className="chat-search-filter flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-[13px] font-medium"
                aria-selected={scope === value}
                disabled={busy}
                style={{
                  background: scope === value ? "var(--chat-fill)" : "transparent",
                }}
                onClick={() => setScope(value)}
              >
                {scope === value ? <Check size={12} aria-hidden /> : null}
                {value}
              </button>
            ))}
          </div>
          <div className="chat-search-results max-h-[min(480px,60vh)] overflow-y-auto">
            {scope === "Archived" && !phrase ? (
              <p className="px-2 pb-1 text-xs text-muted-foreground">Recently archived</p>
            ) : null}
            {page.loading ? (
              <p role="status" className="px-2 py-2 text-xs">
                Searching all chats…
              </p>
            ) : null}
            {page.error || (error && !deletion) ? (
              <p role="alert" className="px-2 py-2 text-xs text-destructive">
                The search could not be updated. Try again.
              </p>
            ) : null}
            <div role="listbox" id={listId} aria-label="Search results">
              {rows.map((row, position) => {
                const project = row.record?.projectId
                  ? projects.find((item) => item.id === row.record?.projectId || item.slug === row.record?.projectId)
                  : row.project;
                return (
                  <div
                    key={row.key}
                    className="chat-search-result-row flex items-center"
                    data-selected={index === position || undefined}
                  >
                    <button
                      type="button"
                      role="option"
                      id={`${listId}-${position}`}
                      aria-selected={index === position}
                      className="flex min-w-0 flex-1 items-center text-left"
                      onClick={() => select(position)}
                    >
                      {row.project ? (
                        <Folder size={16} className="shrink-0" />
                      ) : (
                        <MessageSquare size={16} className="shrink-0" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{row.label}</span>
                        <small className="block truncate text-xs text-muted-foreground">
                          {row.project ? "Project" : (project?.name ?? "Chat")}
                        </small>
                      </span>
                    </button>
                    {scope === "Archived" && row.record ? (
                      <div className="chat-search-row-actions">
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Restore ${row.label}`}
                          title="Restore"
                          onClick={() => {
                            if (row.record) void apply("restore", row.record);
                          }}
                        >
                          <ArchiveRestore size={14} />
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Delete ${row.label}`}
                          title="Delete"
                          onClick={() => setDeletion(row.record!)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {scope === "Shared" && onShared ? (
              <button
                type="button"
                className="flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-accent"
                onClick={() => {
                  onShared();
                  onClose();
                }}
              >
                <Users size={16} />
                Shared with me
              </button>
            ) : null}
            {!rows.length && !page.loading && scope !== "Shared" ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">
                {scope === "Archived" ? "No archived chats." : "No matching chats."}
              </p>
            ) : null}
            {page.cursor ? (
              <button
                type="button"
                className="w-full p-2 text-xs text-muted-foreground"
                disabled={page.loading}
                onClick={() => {
                  void more();
                }}
              >
                Show more
              </button>
            ) : null}
          </div>
          {scope === "Archived" ? (
            <button
              type="button"
              className="chat-search-open-archive"
              onClick={() => {
                onOpenArchived();
                onClose();
              }}
            >
              <Archive size={16} />
              <span>Open archived list</span>
              <CornerDownLeft size={14} />
            </button>
          ) : null}
          <footer className="chat-search-footer">
            <span>↑ ↓ to navigate</span>
            <span>↵ to open</span>
            {scope === "Archived" ? <span>⌘R restore</span> : null}
            <span className="ml-auto">esc to close</span>
          </footer>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deletion)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeletion(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-label="Delete this chat forever?"
          showCloseButton={false}
          className="sm:max-w-[420px]"
          style={{ zIndex: SHELL_Z_INDEX.appDialog + 1 }}
          overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog + 1 }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">Delete this chat forever?</DialogTitle>
            <DialogDescription>
              This permanently deletes the chat and its messages. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              The chat could not be deleted. Try again.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeletion(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (deletion) void apply("delete", deletion);
              }}
            >
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
