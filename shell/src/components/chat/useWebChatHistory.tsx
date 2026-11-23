import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { archiveRestoreLocation, type ChatArchiveClient } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { RenameableConversation } from "./ChatTitleRename";
type Ref = { chatId: string; revision: number };
type Bulk = { archived: Ref[]; archivedCount: number; skippedCount: number };
type Undo = {
  chats: Ref[];
  label: string;
  restoreRecords?: CanonicalChatRecord[];
};
async function applyHistoryUndo(
  target: Undo,
  client: ChatArchiveClient | undefined,
  restore: ((id: string, revision: number) => Promise<boolean>) | undefined,
  restoreMany: ((chats: Ref[]) => Promise<readonly string[]>) | undefined,
): Promise<readonly string[]> {
  if (target.restoreRecords && client) {
    const completed: string[] = [];
    await target.restoreRecords.reduce(
      (prior, record) =>
        prior.then(async () => {
          await client.updateLifecycle(record.chat.id, {
            baseRevision: record.chat.revision,
            lifecycle: "archived",
          });
          completed.push(record.chat.id);
        }),
      Promise.resolve(),
    );
    return completed;
  }
  if (target.chats.length === 1 && restore) {
    const row = target.chats[0]!;
    return (await restore(row.chatId, row.revision)) ? [row.chatId] : [];
  }
  return restoreMany ? restoreMany(target.chats) : [];
}
export function useWebChatHistory({
  archive,
  restore,
  archiveProjectChats,
  restoreMany,
  client,
  authorityKey,
  projectName,
}: {
  archive?(id: string): Promise<Ref | null>;
  restore?(id: string, revision: number): Promise<boolean>;
  archiveProjectChats?(id: string): Promise<Bulk | null>;
  restoreMany?(chats: Ref[]): Promise<readonly string[]>;
  client?: ChatArchiveClient;
  authorityKey?: string;
  projectName?(id: string): string | undefined;
}) {
  const [deletedChatIds, setDeletedChatIds] = useState<readonly string[]>([]);
  const [projectArchiveVersion, setProjectArchiveVersion] = useState(0),
    [searchRefreshVersion, setSearchRefreshVersion] = useState(0);
  const [archivesOpen, setArchivesOpen] = useState(false),
    [undo, setUndoState] = useState<Undo | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const generation = useRef(0),
    lock = useRef(false);
  const undoRef = useRef<Undo | null>(null);
  const setUndo = (value: Undo | null) => {
    undoRef.current = value;
    setUndoState(value);
  };
  useEffect(() => {
    generation.current++;
    setDeletedChatIds([]);
    setArchivesOpen(false);
    setUndo(null);
    setPending(false);
    setError(false);
    return () => {
      generation.current++;
    };
  }, [authorityKey, client]);
  useEffect(() => {
    if (!undo || pending) return;
    const timer = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(timer);
  }, [undo, pending]);
  const changed = useCallback(() => {
    setProjectArchiveVersion((value) => value + 1);
    setSearchRefreshVersion((value) => value + 1);
  }, []);
  const archiveChat = async (conv: RenameableConversation) => {
    if (!archive) return;
    const current = generation.current;
    const value = await archive(conv.id);
    if (current !== generation.current || !value) return;
    setDeletedChatIds((rows) => [...rows.slice(-199), conv.id]);
    setError(false);
    setUndo({
      chats: [value],
      label: `Archived ${conv.title || conv.preview || "New chat"}`,
    });
    changed();
  };
  const archiveProject = async (id: string, slug: string, name: string) => {
    if (!archiveProjectChats) return false;
    const current = generation.current;
    const results = await Promise.allSettled([...new Set([id, slug])].map((ref) => archiveProjectChats(ref)));
    if (current !== generation.current) return false;
    const completed = results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
    const archived = [
      ...new Map(completed.flatMap((result) => result.archived).map((row) => [row.chatId, row])).values(),
    ];
    const skipped = completed.reduce((sum, result) => sum + result.skippedCount, 0);
    if (archived.length) {
      setDeletedChatIds((rows) => [...rows, ...archived.map((row) => row.chatId)].slice(-200));
      changed();
    }
    if (archived.length || skipped) {
      setError(false);
      setUndo({
        chats: archived,
        label: `Archived ${archived.length} chats in ${name}${skipped ? `; ${skipped} running skipped` : ""}`,
      });
    }
    return results.length === completed.length;
  };
  const onRestored = (record: CanonicalChatRecord) => {
    setDeletedChatIds((rows) => rows.filter((id) => id !== record.chat.id));
    changed();
    setError(false);
    setUndo({
      chats: [],
      restoreRecords: [record],
      label: `Restored to ${archiveRestoreLocation(record, record.projectId ? projectName?.(record.projectId) : undefined)}`,
    });
  };
  const undoAction = () => {
    if (!undo || lock.current) return;
    lock.current = true;
    setPending(true);
    setError(false);
    const current = generation.current;
    const target = undo;
    return applyHistoryUndo(target, client, restore, restoreMany)
      .then((completed) => {
        if (current !== generation.current) return;
        setDeletedChatIds((rows) =>
          target.restoreRecords ? [...rows, ...completed].slice(-200) : rows.filter((id) => !completed.includes(id)),
        );
        changed();
        const remaining = target.chats.filter((row) => !completed.includes(row.chatId));
        const records = target.restoreRecords?.filter((row) => !completed.includes(row.chat.id));
        if (undoRef.current !== target) return;
        if (remaining.length || records?.length) {
          setUndo({ ...target, chats: remaining, restoreRecords: records });
          setError(true);
        } else setUndo(null);
      })
      .catch((cause: unknown) => {
        console.warn("[chat-history] Undo failed:", cause instanceof Error ? cause.name : "UnknownError");
        if (current === generation.current && undoRef.current === target) setError(true);
      })
      .finally(() => {
        lock.current = false;
        if (current === generation.current) setPending(false);
      });
  };
  const pageClient = useMemo(
    () =>
      client
        ? {
            ...client,
            updateLifecycle: async (id: string, input: { baseRevision: number; lifecycle: "active" | "archived" }) => {
              const current = generation.current;
              const result = await client.updateLifecycle(id, input);
              if (current !== generation.current) throw new Error("ChatAuthorityChanged");
              setDeletedChatIds((rows) =>
                input.lifecycle === "active"
                  ? rows.filter((value) => value !== id)
                  : [...rows.filter((value) => value !== id).slice(-199), id],
              );
              return result;
            },
          }
        : undefined,
    [client],
  );
  const toast = undo ? (
    <div role="status" className="desktop-chat-design chat-lifecycle-toast">
      <span>{error ? "Chats could not be restored. Try again." : undo.label}</span>
      {undo.chats.length || undo.restoreRecords?.length ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            void undoAction();
          }}
        >
          Undo
        </button>
      ) : null}
      {!undo.restoreRecords ? (
        <button type="button" onClick={() => setArchivesOpen(true)}>
          View archived
        </button>
      ) : null}
    </div>
  ) : null;
  return {
    pageClient,
    deletedChatIds,
    setDeletedChatIds,
    projectArchiveVersion,
    setProjectArchiveVersion,
    searchRefreshVersion,
    setSearchRefreshVersion,
    archivesOpen,
    setArchivesOpen,
    archiveChat,
    archiveProject,
    onRestored,
    changed,
    toast,
  };
}
type SearchConversationMeta = RenameableConversation & {
  projectId?: string;
  importSource?: import("@matrix-os/contracts").CanonicalChatImportSource;
  searchActiveRun?: boolean;
};

function searchConversationRow(record: import("@matrix-os/contracts").CanonicalChatRecord): SearchConversationMeta {
  return {
    id: record.chat.id,
    title: record.chat.title,
    preview: record.chat.title,
    messageCount: record.chat.messageCount,
    updatedAt: Date.parse(record.chat.activityAt ?? record.chat.updatedAt),
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.importSource ? { importSource: record.importSource } : {}),
    ...(record.readState ? { readState: record.readState } : {}),
    searchActiveRun: Boolean(record.activeRun),
  };
}

export function useInlineChatSearch(
  searchConversations:
    | ((
        query: string,
        input?: {
          lifecycle?: "active" | "archived";
          limit?: number;
          cursor?: string;
        },
      ) => Promise<import("@matrix-os/contracts").CanonicalChatListResponse>)
    | undefined,
  trimmedSearch: string,
  scopeKey: string,
) {
  const searchKey = JSON.stringify([scopeKey, trimmedSearch]);
  const [serverSearch, setServerSearch] = useState<{
    key: string;
    rows: SearchConversationMeta[];
    loading: boolean;
    error: boolean;
    nextCursor?: string;
    loadingMore?: boolean;
    loadMoreError?: boolean;
  }>({ key: "", rows: [], loading: false, error: false });
  useEffect(() => {
    if (!trimmedSearch || !searchConversations) return;
    let current = true;
    setServerSearch({ key: searchKey, rows: [], loading: true, error: false });
    const timer = window.setTimeout(() => {
      void searchConversations(trimmedSearch, {
        lifecycle: "active",
        limit: 50,
      })
        .then((page) => {
          if (!current) return;
          setServerSearch({
            key: searchKey,
            rows: page.items.map(searchConversationRow),
            loading: false,
            error: false,
            nextCursor: page.nextCursor,
          });
        })
        .catch((cause: unknown) => {
          if (!current) return;
          console.warn("[chat-search] Search unavailable:", cause instanceof Error ? cause.name : "UnknownError");
          setServerSearch({
            key: searchKey,
            rows: [],
            loading: false,
            error: true,
          });
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [trimmedSearch, searchConversations, searchKey]);
  const loadMoreSearch = () => {
    const cursor = serverSearch.nextCursor;
    if (!cursor || !searchConversations || serverSearch.loadingMore || serverSearch.key !== searchKey) return;
    setServerSearch((state) => ({
      ...state,
      loadingMore: true,
      loadMoreError: false,
    }));
    void searchConversations(trimmedSearch, {
      lifecycle: "active",
      limit: 50,
      cursor,
    })
      .then((page) => {
        setServerSearch((state) => {
          if (state.key !== searchKey) return state;
          const ids = new Set(state.rows.map((row) => row.id));
          return {
            ...state,
            rows: [...state.rows, ...page.items.map(searchConversationRow).filter((row) => !ids.has(row.id))].slice(
              -500,
            ),
            nextCursor: page.nextCursor,
            loadingMore: false,
          };
        });
      })
      .catch((cause: unknown) => {
        console.warn("[chat-search] Search page unavailable:", cause instanceof Error ? cause.name : "UnknownError");
        setServerSearch((state) =>
          state.key === searchKey ? { ...state, loadingMore: false, loadMoreError: true } : state,
        );
      });
  };
  return { searchKey, serverSearch, loadMoreSearch };
}

export function useWebChatRowShortcuts({
  active,
  record,
  archive,
  pin,
  rename,
  read,
}: {
  active: boolean;
  record?: RenameableConversation;
  archive?(record: RenameableConversation): void | Promise<void>;
  pin?(record: RenameableConversation): void;
  rename?(record: RenameableConversation): void;
  read?(record: RenameableConversation): void;
}) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (!active || !record || event.defaultPrevented || event.repeat || !event.metaKey) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input,textarea,[contenteditable=true],[role=dialog],[role=menu]")
    )
      return;
    const key = event.key.toLowerCase();
    if (event.shiftKey && key === "a" && archive && !record.canonicalRecord?.activeRun) {
      event.preventDefault();
      void archive(record);
    } else if (event.altKey && key === "p" && pin) {
      event.preventDefault();
      pin(record);
    } else if (event.altKey && key === "r" && rename) {
      event.preventDefault();
      rename(record);
    } else if (event.shiftKey && key === "u" && read) {
      event.preventDefault();
      read(record);
    }
  });
  useEffect(() => {
    if (!active) return;
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [active]);
}

/** Preserve an unsent main-chat draft when copying an answer from Side chat. */
export function appendSideChatAnswer(draft: string, answer: string): string {
  return draft.trim() ? `${draft}\n\n${answer}` : answer;
}
