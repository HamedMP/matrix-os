"use client";

import {
  useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode,
} from "react";
import { ExternalLink, PanelLeft } from "lucide-react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../chat-agents/client.js";
import { BrainButton } from "./brain-controls.js";
import { readRemembered, writeRemembered } from "./brain-memory.js";
import { BRAIN_TONE } from "./brain-tone.js";
import { brainErrorText } from "./brain-format.js";
import type { BrainShellClient, BrainShellErrorState } from "./brain-types.js";
import { BrainEmpty, BrainError, BrainLoading } from "./brain-ui.js";
import { BrainChatList, type BrainChatRowActions } from "./BrainChatList.js";
import { createCompanyBrainBot, findCompanyBrainBot, type CompanyBrainBotState } from "./company-brain-bot.js";
import { BRAIN_LIST_MAX_ITEMS, useBrainLoad } from "./use-brain-load.js";
import { brainChatStorageKey, useBrainThreads } from "./use-brain-threads.js";

/**
 * What a surface lends the Brain app so its Chat tab shows that surface's own chat view: the brain chat is an
 * ordinary Matrix Chat run by the Company Brain Bot, never a second chat system.
 */
export interface BrainChatHost {
  /** The surface's Chat Agents client (createChatAgentClient over its own transport). */
  readonly agents: ChatAgentClient;
  /** Renders the surface's chat view for one Chat, or a draft that becomes a thread on its first send. */
  readonly render: (slot: BrainChatSlot) => ReactNode;
  /** Opens the same Chat in the Chat window or tab. */
  readonly openInChat?: (chatId: string) => void;
  /** Rename and delete a past brain chat over the normal Chat routes; without them the rows only open. */
  readonly rows?: BrainChatRowActions;
}

export interface BrainChatSlot {
  readonly projectId: string;
  readonly agentId: string;
  /** The Chat to show, or null for a draft. A draft saves nothing until its first send. */
  readonly chatId: string | null;
  /** The empty chat's heading, such as "Ask about matrix-os". */
  readonly prompt: string;
  /** The line under that heading; the same text on every surface. */
  readonly promptDetail: string;
  /**
   * Called by the view on the first send of a draft; one thread per draft, however often it is called. The slot shows
   * the new thread as soon as it exists, even when its first turn then fails.
   */
  readonly createChat: (input: { readonly clientRequestId: string; readonly title: string }) => Promise<CanonicalChatRecord>;
  /** The view reports its Chat after every admitted turn (null after its own New chat), so the list stays current. */
  readonly onChatChanged: (chatId: string | null, title?: string) => void;
}

const NOT_RUNNING = "Chat with the brain is not running on this computer. Search, Today, Decisions and Timeline still work.";
const ARCHIVED = "The Company Brain chat was archived, so it cannot start here. Search, Today, Decisions and Timeline still work.";
const PROMPT_DETAIL = "Answers come only from this project's brain, with a link to every source.";
/** A project with no sources reads like the routes' own git_source_missing answer. */
const NO_SOURCES: BrainShellErrorState = { kind: "rejected", code: "git_source_missing" };

function ChatNotice({ text, onOpenSearch, onOpenSources, onCheckAgain }: {
  readonly text: string; readonly onOpenSearch?: () => void; readonly onOpenSources?: () => void;
  readonly onCheckAgain?: () => void;
}) {
  return (
    <div className="p-4">
      <BrainEmpty title={text}>
        {onOpenSources && <BrainButton size="sm" variant="outline" onClick={onOpenSources}>Open Sources</BrainButton>}
        {onCheckAgain && <BrainButton size="sm" variant="outline" onClick={onCheckAgain}>Check again</BrainButton>}
        {onOpenSearch && <BrainButton size="sm" variant="outline" onClick={onOpenSearch}>Open Search</BrainButton>}
      </BrainEmpty>
    </div>
  );
}

interface BrainChatProps {
  readonly host: BrainChatHost | undefined; readonly api: BrainShellClient; readonly projectId: string;
  readonly projectName: string; readonly onOpenSearch: () => void; readonly onOpenSources: () => void;
}

/**
 * The Chat tab: finds the owner's Company Brain Bot (or offers to start it), lists this project's brain chats and
 * hosts the surface's chat view for the open one.
 */
export function BrainChat({ host, ...props }: BrainChatProps) {
  if (!host) return <ChatNotice text="Chat is not available here." onOpenSearch={props.onOpenSearch} />;
  return <BrainChatBot host={host} {...props} />;
}

type BotProps = Omit<BrainChatProps, "host"> & { readonly host: BrainChatHost };

/**
 * What stands in for a new chat while the brain is off, or the project has no sources yet: a question could then only
 * get "I could not find that". Null when a new chat can be asked. Saved chats open either way. While no source is
 * connected, the sources load again when the window gets focus or on Check again, so one connected elsewhere unblocks.
 */
function useDraftNotice(api: BrainShellClient, projectId: string, onOpenSources: () => void): ReactNode {
  const sources = useBrainLoad(() => api.sources(projectId), "sources");
  const state = sources.state;
  const missing = state.status === "ready" && (!Array.isArray(state.data.items) || state.data.items.length === 0);
  const onFocus = useEffectEvent(() => { if (missing) sources.reload(); });
  useEffect(() => {
    const listener = () => onFocus();
    window.addEventListener("focus", listener);
    return () => window.removeEventListener("focus", listener);
  }, []);
  if (state.status === "loading" || state.status === "idle") return <BrainLoading label="Checking the project's sources..." />;
  if (state.status === "error") {
    return <div className="p-4"><BrainError error={state.error} onRetry={sources.reload} onOpenSources={onOpenSources} /></div>;
  }
  if (missing) {
    return <ChatNotice text={brainErrorText(NO_SOURCES)} onOpenSources={onOpenSources} onCheckAgain={sources.reload} />;
  }
  return null;
}

function BrainChatBot({ host, ...props }: BotProps) {
  const bot = useBrainLoad(() => findCompanyBrainBot(host.agents), "bot");
  const [starting, setStarting] = useState<"idle" | "busy" | "failed">("idle");
  const start = () => {
    setStarting("busy");
    createCompanyBrainBot(host.agents).then(
      (state) => { setStarting("idle"); bot.replace(state); },
      (error: unknown) => {
        console.warn("[brain] chat setup failed", error instanceof Error ? error.name : typeof error);
        setStarting("failed");
      },
    );
  };
  const state = bot.state;
  if (state.status === "loading" || state.status === "idle") return <BrainLoading label="Opening the brain chat..." />;
  if (state.status === "error") {
    return (
      <div role="alert" className={`m-4 flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm ${BRAIN_TONE.warn}`}>
        <p className="min-w-0 flex-1">The brain chat could not be opened.</p>
        <BrainButton size="sm" variant="outline" onClick={bot.reload}>Try again</BrainButton>
      </div>
    );
  }
  return <BrainChatState state={state.data} host={host} starting={starting} onStart={start} {...props} />;
}

function BrainChatState({ state, starting, onStart, ...props }: BotProps & {
  readonly state: CompanyBrainBotState; readonly starting: "idle" | "busy" | "failed"; readonly onStart: () => void;
}) {
  switch (state.kind) {
    case "unavailable": return <ChatNotice text={NOT_RUNNING} onOpenSearch={props.onOpenSearch} />;
    case "archived": return <ChatNotice text={ARCHIVED} onOpenSearch={props.onOpenSearch} />;
    case "setup": return <BrainChatSetup starting={starting} onStart={onStart} />;
    case "ready": return <BrainChatThreads botId={state.botId} {...props} />;
  }
}

function BrainChatSetup({ starting, onStart }: { readonly starting: "idle" | "busy" | "failed"; readonly onStart: () => void }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`m-4 grid max-w-lg gap-3 rounded-xl border p-4 ${BRAIN_TONE.border}`}>
      <h2 id={headingId} className="text-base font-semibold">Chat with your Company Brain</h2>
      <p className="text-sm">
        Ask about a project in plain English. Answers come only from its brain, with a link to every source. Your
        chats are saved and open on every device.
      </p>
      <p className="text-xs text-muted-foreground">
        It picks a model for you (Automatic). You can change the model later in the chat. Answers are billed like any
        Chat.
      </p>
      {starting === "failed" && (
        <p role="alert" className={`text-sm ${BRAIN_TONE.warnText}`}>The brain chat could not be started. Try again.</p>
      )}
      <BrainButton className="justify-self-start" disabled={starting === "busy"} onClick={onStart}>
        {starting === "busy" ? "Starting..." : "Start"}
      </BrainButton>
    </section>
  );
}

interface Opened { readonly key: string; readonly chatId: string | null; readonly title: string | null; readonly slot: number }
type BrainThreads = ReturnType<typeof useBrainThreads>;

function opening(key: string, record: CanonicalChatRecord | null, slot: number): Opened {
  return { key, chatId: record?.chat.id ?? null, title: record?.chat.title ?? null, slot };
}

/**
 * The chat to open first once the list loads: the remembered one if a loaded page has it, else the newest, else null
 * (a draft). A remembered chat opened through Show more is on a later page, so while `choosing` the later pages load
 * ("searching") until it is found, the list ends or reaches its cap, or a page fails.
 */
function useFirstPick(threads: BrainThreads, projectId: string, choosing: boolean): CanonicalChatRecord | null | "searching" {
  const remembered = choosing ? readRemembered(brainChatStorageKey(projectId), "chat") : "";
  const found = remembered === "" ? undefined : threads.items.find((record) => record.chat.id === remembered);
  const searching = remembered !== "" && found === undefined && threads.nextCursor !== null && threads.moreError === null;
  const { loadingMore } = threads;
  const loadMore = useEffectEvent(() => threads.loadMore());
  useEffect(() => {
    if (searching && !loadingMore) loadMore();
  }, [searching, loadingMore]);
  return searching ? "searching" : found ?? threads.items[0] ?? null;
}

/**
 * Which chat the slot shows, decided here for every surface. Opening order, once per Bot and project: the chat this
 * viewer had open last if it is still listed (on any page up to the list cap), else the one with the newest activity
 * (the same on every surface), else a draft. A list that fails to load opens a draft. The open chat is remembered, the
 * first pick included. A new slot number remounts the surface's chat view; a draft that becomes a thread keeps it.
 */
function useBrainChatSlot(host: BrainChatHost, botId: string, projectId: string, threads: BrainThreads) {
  const key = `${botId}:${projectId}`;
  const [opened, setOpened] = useState<Opened | null>(null);
  // One thread per draft: a second call for the same draft gets the same answer, and a send after a failure keeps the
  // draft's first request id, so a thread saved before its answer was lost is replayed, not made twice.
  const creating = useRef<{
    slot: number; clientRequestId: string; promise: Promise<CanonicalChatRecord> | null;
  } | null>(null);
  const firstStatus = threads.first.state.status;
  const choosing = opened?.key !== key && (firstStatus === "ready" || firstStatus === "error");
  const pick = useFirstPick(threads, projectId, choosing);
  if (choosing && pick !== "searching") setOpened(opening(key, pick, (opened?.slot ?? 0) + 1));
  const current = opened?.key === key ? opened : null;
  const openChatId = current?.chatId ?? null;
  useEffect(() => {
    if (openChatId !== null) writeRemembered(brainChatStorageKey(projectId), openChatId, "chat");
  }, [openChatId, projectId]);
  const slotNumber = current?.slot ?? 0;
  const { reload } = threads;
  const open = (record: CanonicalChatRecord | null) => setOpened((value) => opening(key, record, (value?.slot ?? 0) + 1));
  // A delete settles later: it moves the viewer only if the deleted chat is still the one open by then.
  const closeDeleted = (chatId: string, next: () => CanonicalChatRecord | null) => setOpened((value) => (
    value?.key === key && value.chatId === chatId ? opening(key, next(), value.slot + 1) : value));
  // The view of this slot now shows `chatId`; the list reloads so it sorts and dates the chat like the server does.
  const shown = useCallback((chatId: string | null, title: string | undefined) => {
    setOpened((value) => (value?.key === key && value.slot === slotNumber ? {
      ...value, chatId, title: title ?? (chatId === value.chatId ? value.title : null),
    } : value));
    reload();
  }, [key, reload, slotNumber]);
  const createChat = useCallback((input: { readonly clientRequestId: string; readonly title: string }) => {
    const draft = creating.current?.slot === slotNumber ? creating.current : null;
    if (draft?.promise) return draft.promise;
    const clientRequestId = draft?.clientRequestId ?? input.clientRequestId;
    const bots = host.agents.bots;
    const promise = bots
      ? bots.threads.create(botId, { clientRequestId, projectId, title: input.title })
      : Promise.reject(new Error("BotsUnavailable"));
    const entry = { slot: slotNumber, clientRequestId, promise };
    creating.current = entry;
    promise.then(
      (record) => { if (creating.current === entry) shown(record.chat.id, record.chat.title); },
      // A failed create may be sent again; the same request id lets the server replay a thread it already saved.
      () => { if (creating.current === entry) creating.current = { slot: slotNumber, clientRequestId, promise: null }; },
    );
    return promise;
  }, [botId, host.agents, projectId, shown, slotNumber]);
  const onChatChanged = useCallback((chatId: string | null, title?: string) => {
    if (chatId === null) creating.current = null;
    shown(chatId, title);
  }, [shown]);
  return { key, current, open, closeDeleted, createChat, onChatChanged };
}

/**
 * Renames (the renamed record, whose title and title version show) and deletes (null) made here, each kept over the
 * record it was made on while the list still holds that record: once the chat is read again (a reload, or a new Show
 * more), the server's title shows, a later rename elsewhere too, and a chat no longer listed drops its edit. At most
 * one per item a list holds, the oldest dropped.
 */
type LocalEdits = ReadonlyMap<string, {
  readonly value: CanonicalChatRecord | null; readonly over: CanonicalChatRecord;
}>;

function pendingEdits(edits: LocalEdits, listed: readonly CanonicalChatRecord[]): LocalEdits {
  if (edits.size === 0) return edits;
  const pending = [...edits].filter(([, edit]) => listed.includes(edit.over));
  return pending.length === edits.size ? edits : new Map(pending);
}

function withEdit(
  edits: LocalEdits, id: string, value: CanonicalChatRecord | null, over: CanonicalChatRecord,
): LocalEdits {
  const next = new Map(edits);
  next.delete(id);
  next.set(id, { value, over });
  for (const oldest of next.keys()) {
    if (next.size <= BRAIN_LIST_MAX_ITEMS) break;
    next.delete(oldest);
  }
  return next;
}

function BrainChatThreads({
  host, api, botId, projectId, projectName, onOpenSearch, onOpenSources,
}: BotProps & { readonly botId: string }) {
  const threads = useBrainThreads(host.agents, botId, projectId);
  const draftNotice = useDraftNotice(api, projectId, onOpenSources);
  const { key, current, open, closeDeleted, createChat, onChatChanged } = useBrainChatSlot(host, botId, projectId, threads);
  const [listOpen, setListOpen] = useState(false);
  const [edits, setEdits] = useState<LocalEdits>(() => new Map());
  const pending = pendingEdits(edits, threads.items);
  if (pending !== edits) setEdits(pending);
  const items = threads.items.flatMap((record) => {
    const edit = pending.get(record.chat.id);
    if (edit === undefined) return [record];
    if (edit.value === null) return [];
    const { title, titleVersion } = edit.value.chat;
    return [{ ...record, chat: { ...record.chat, title, titleVersion } }];
  });
  // The list as it is when a delete settles, to pick the chat that opens in place of the deleted one, and the records
  // an edit that settles is kept over (a reload may have landed while it was on its way).
  const listedNow = useRef(items);
  const loaded = useRef(threads.items);
  useLayoutEffect(() => { listedNow.current = items; loaded.current = threads.items; }, [items, threads.items]);
  const toggle = useRef<HTMLButtonElement>(null);
  const listId = useId();
  if (threads.notRunning) return <ChatNotice text={NOT_RUNNING} onOpenSearch={onOpenSearch} />;
  if (current === null) return <BrainLoading label="Loading chats..." />;
  const { chatId } = current;
  const listed = items.find((record) => record.chat.id === chatId)?.chat.title;
  const title = chatId === null ? "New chat" : listed ?? current.title ?? "Chat";
  const closeList = () => {
    setListOpen(false);
    toggle.current?.focus();
  };
  const edit = (id: string, value: CanonicalChatRecord | null) => {
    const over = loaded.current.find((record) => record.chat.id === id);
    if (over) setEdits((previous) => withEdit(previous, id, value, over));
    threads.reload();
  };
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] @2xl:grid-cols-[15rem_minmax(0,1fr)] @2xl:grid-rows-1">
      <BrainChatList id={listId} shown={listOpen} threads={threads} items={items} chatId={chatId} projectName={projectName}
        actions={host.rows ?? null} onClose={closeList}
        onOpen={(record) => {
          open(record);
          if (listOpen) closeList();
        }}
        onRenamed={(renamed) => edit(renamed.chat.id, renamed)}
        onDeleted={(id) => {
          edit(id, null);
          closeDeleted(id, () => listedNow.current.find((record) => record.chat.id !== id) ?? null);
        }} />
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className={`flex min-h-11 items-center gap-2 border-b px-2 ${BRAIN_TONE.border}`}>
          <BrainButton ref={toggle} size="sm" variant="ghost" className="@2xl:hidden" aria-expanded={listOpen}
            aria-controls={listId} onClick={() => setListOpen((value) => !value)}>
            <PanelLeft className="size-4" aria-hidden="true" />
            Chats
          </BrainButton>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
          {chatId !== null && host.openInChat && (
            <BrainButton size="sm" variant="ghost" onClick={() => host.openInChat?.(chatId)}>
              <ExternalLink className="size-4" aria-hidden="true" />
              Open in Chat
            </BrainButton>
          )}
        </div>
        <div key={`${key}:${current.slot}`} className="flex min-h-0 flex-1 flex-col">
          {(chatId === null ? draftNotice : null) ?? host.render({
            projectId, agentId: botId, chatId, prompt: `Ask about ${projectName}`, promptDetail: PROMPT_DETAIL,
            createChat, onChatChanged,
          })}
        </div>
      </div>
    </div>
  );
}
