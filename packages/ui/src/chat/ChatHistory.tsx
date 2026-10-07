"use client";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatContextMenu } from "./ChatContextMenu.js";
import { ChatIcon } from "./ChatIcon.js";
import "./chat-presentation.css";

export interface ChatHistoryItem {
  id: string;
  title: string;
  preview?: string;
  updatedAt: number;
  unread?: boolean;
  conversationKind?: "chat" | "voice";
}
export interface ChatHistoryProps {
  items: readonly ChatHistoryItem[];
  activeChatId?: string | null;
  loading?: boolean;
  error?: string | null;
  onSelect(id: string): void;
  onNewChat(): void;
  onRename?(id: string, title: string): Promise<boolean>;
  renameDisabled?: boolean;
  onDelete?(id: string): void;
  onToggleRead?(id: string): void;
  onQueryChange?(query: string): void;
  /** Remote items already include message-content matches. */
  searchMode?: "local" | "remote";
  children?: ReactNode;
  searchIcon?: ReactNode;
  newChatIcon?: ReactNode;
  unreadOnly?: boolean;
  onUnreadOnlyChange?(value: boolean): void;
}

export function ChatHistory(props: ChatHistoryProps) {
  const [kind, setKind] = useState<"chat" | "voice">(() => props.items.find(item => item.id === props.activeChatId)?.conversationKind ?? "chat");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const queryChange = useRef(props.onQueryChange);
  const lastQuery = useRef("");
  useEffect(() => { queryChange.current = props.onQueryChange; }, [props.onQueryChange]);
  useEffect(() => {
    if (query === lastQuery.current || !queryChange.current) return;
    const timer = setTimeout(() => {
      lastQuery.current = query;
      queryChange.current?.(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  const clearSearch = () => {
    setQuery("");
    if (query || lastQuery.current) queryChange.current?.("");
    lastQuery.current = "";
    setSearchOpen(false);
  };
  const [localUnreadOnly, setLocalUnreadOnly] = useState(false);
  const unreadOnly = props.unreadOnly ?? localUnreadOnly;
  const panelId = useId();
  const [optionsId, setOptionsId] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; value: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const pendingRef = useRef(false);
  const mounted = useRef(true);
  const selectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (selectTimer.current) clearTimeout(selectTimer.current); }, []);
  const previousActive = useRef<string | null | undefined>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const active = props.items.find(item => item.id === props.activeChatId);
    if (active && previousActive.current !== active.id) {
      setKind(active.conversationKind ?? "chat"); previousActive.current = active.id;
    }
  }, [props.activeChatId, props.items]);
  const shown = useMemo(() => props.items.filter(item => (item.conversationKind ?? "chat") === kind
    && (!unreadOnly || item.unread)
    && (props.searchMode === "remote" || `${item.title} ${item.preview ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
    .sort((a, b) => b.updatedAt - a.updatedAt), [props.items, props.searchMode, kind, query, unreadOnly]);
  const voices = props.items.filter(item => item.conversationKind === "voice");
  const unreadVoices = voices.filter(item => item.unread).length;
  const saveTitle = async () => {
    if (!rename?.value.trim() || !props.onRename || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setRenameError(false);
    try {
      const saved = await props.onRename(rename.id, rename.value.trim());
      if (mounted.current) { if (saved) setRename(null); else setRenameError(true); }
    } catch (error: unknown) {
      console.warn("[chat] title unavailable", error instanceof Error ? error.name : "UnknownError");
      if (mounted.current) setRenameError(true);
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  };
  return <nav className="matrix-chat-history" aria-label="Conversation navigation">
    <header className="matrix-chat-history__header"><h2 className="text-[14px] font-medium leading-[20px]">Chats</h2>
      <button type="button" aria-label="Search chats" aria-expanded={searchOpen} onClick={() => { if (searchOpen) clearSearch(); else setSearchOpen(true); }}>{props.searchIcon ?? <ChatIcon name="search" />}</button>
    </header>
    <button type="button" className="matrix-chat-history__new" onClick={() => { setKind("chat"); props.onNewChat(); }}>{props.newChatIcon ?? <ChatIcon name="add" />}<span>New chat</span></button>
    {props.children}
    <div className="matrix-chat-history__tabs" role="tablist" aria-label="Conversation history" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "chat" : event.key === "End" ? "voice" : kind === "chat" ? "voice" : "chat";
      setKind(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-kind="${next}"]`)?.focus();
    }}>
      <button type="button" role="tab" data-kind="chat" id={`${panelId}-chat`} aria-controls={panelId} tabIndex={kind === "chat" ? 0 : -1} aria-selected={kind === "chat"} onClick={() => setKind("chat")}>Chats</button>
      <button type="button" role="tab" data-kind="voice" id={`${panelId}-voice`} aria-controls={panelId} tabIndex={kind === "voice" ? 0 : -1} aria-selected={kind === "voice"} onClick={() => setKind("voice")}>Voice conversations{unreadVoices > 0 ? <span className="matrix-chat-history__badge">{unreadVoices}</span> : null}</button>
    </div>
    <button type="button" className="matrix-chat-history__unread-filter" aria-pressed={unreadOnly} onClick={() => { setLocalUnreadOnly(!unreadOnly); props.onUnreadOnlyChange?.(!unreadOnly); }}>Unread</button>
    {searchOpen ? <input autoFocus type="search" aria-label="Search chats" className="matrix-chat-history__search" placeholder="Search chats" value={query}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === "Escape") clearSearch(); }} /> : null}
    {props.error ? <p role="alert">Conversations could not be loaded. Try again.</p> : null}
    {props.loading && shown.length === 0 ? <p role="status" aria-label="Loading chats">Loading chats…</p> : null}
    {renameError ? <p role="alert">Title could not be saved. Try again.</p> : null}
    <div className="matrix-chat-history__list" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${kind}`}>
      <span className="matrix-chat-history__label">{kind === "voice" ? "Voice conversations" : "Recents"}</span>
      {shown.map(item => <ChatContextMenu key={item.id} chatId={item.id} items={props.onRename ? [{ label: "Rename", disabled: pending || props.renameDisabled, onSelect: () => { setRename({ id: item.id, value: item.title }); setRenameError(false); } }] : []} primaryAction={props.onToggleRead ? { label: item.unread ? "Mark as read" : "Mark as unread", onSelect: () => props.onToggleRead?.(item.id) } : undefined}>
        <div className="matrix-chat-history__row" data-active={item.id === props.activeChatId}>
          {rename && rename.id === item.id ? <form onSubmit={event => { event.preventDefault(); void saveTitle(); }}>
            <input autoFocus aria-label={`Rename ${item.title}`} maxLength={160} value={rename.value} disabled={pending}
              onChange={event => setRename({ id: item.id, value: event.target.value })}
              onKeyDown={event => { if (event.key === "Escape" && !pending) { setRename(null); setRenameError(false); } }} />
            <button type="submit" disabled={pending || !rename.value.trim()}>Save</button>
          </form> : <>
            <button type="button" className="matrix-chat-history__select" aria-label={item.title} aria-current={item.id === props.activeChatId ? "page" : undefined} onClick={event => {
              if (!props.onRename || event.detail === 0 || props.renameDisabled) { props.onSelect(item.id); return; }
              if (selectTimer.current) clearTimeout(selectTimer.current);
              selectTimer.current = setTimeout(() => { selectTimer.current = null; props.onSelect(item.id); }, 250);
            }} onDoubleClick={props.onRename && !pending && !props.renameDisabled ? event => {
              event.preventDefault(); if (selectTimer.current) clearTimeout(selectTimer.current); selectTimer.current = null;
              setRename({ id: item.id, value: item.title }); setRenameError(false);
            } : undefined}>
              {item.unread ? <span className="matrix-chat-history__unread" aria-label="Unread" /> : null}<span className="matrix-chat-history__text">
                <span className="text-[14px] leading-[20px]">{item.title}</span>
                {item.preview ? <span className="matrix-chat-history__preview text-[12px] leading-[16px]">{item.preview}</span> : null}
              </span>
            </button>
            {props.onRename || props.onDelete || props.onToggleRead ? <button type="button" aria-label={`Options for ${item.title}`} aria-expanded={optionsId === item.id} className="matrix-chat-history__options-trigger" onClick={() => setOptionsId(value => value === item.id ? null : item.id)}><ChatIcon name="more" size={14} /></button> : null}
            {optionsId === item.id ? <div className="matrix-chat-history__options">
              {props.onRename ? <button type="button" disabled={pending || props.renameDisabled} onClick={() => { setRename({ id: item.id, value: item.title }); setRenameError(false); setOptionsId(null); }}>Rename</button> : null}
              {props.onToggleRead ? <button type="button" onClick={() => { props.onToggleRead?.(item.id); setOptionsId(null); }}>{item.unread ? "Mark as read" : "Mark as unread"}</button> : null}
              {props.onDelete ? <button type="button" onClick={() => { props.onDelete?.(item.id); setOptionsId(null); }}>Delete</button> : null}
            </div> : null}
            {props.onDelete ? <button type="button" className="matrix-chat-history__delete" aria-label={`Delete ${item.title}`} onClick={() => props.onDelete?.(item.id)}>Delete</button> : null}
          </>}
        </div>
      </ChatContextMenu>)}
      {!props.loading && shown.length === 0 ? <p>{query.trim() ? "No matching conversations." : kind === "voice" ? "No voice conversations yet." : "No chats yet."}</p> : null}
    </div>
  </nav>;
}
