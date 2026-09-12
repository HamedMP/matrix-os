import {
  CollaborationChatMessagesResponseSchema,
  CollaborationChatSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationDiscoveryItemSchema,
  CollaborationInvitationSchema,
  CollaborationProjectSchema,
  CollaborationScopeSchema,
  CollaborationSharedChatMessageSchema,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod/v4";
import { ChatAttachments, type ChatMessageAttachment } from "../chat/ChatAttachments.js";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { collaborationDraftKey, collaborationDraftModeKey, createCollaborationDraftStore, type CollaborationDraft } from "./chat-state.js";
import { deriveChatPermissions } from "./permissions.js";
import { SharedChatControls } from "./SharedChatControls.js";
import { SharedTerminalControls } from "./SharedTerminalControls.js";

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryItemSchema>;
type SharedMessage = z.infer<typeof CollaborationSharedChatMessageSchema>;

export type ChatCollaborationView =
  | { kind: "home" }
  | { kind: "invitation"; invitationId: string }
  | { kind: "chat"; scopeId: string }
  | { kind: "terminal"; scopeId: string }
  | { kind: "project"; scopeId: string };

export function ChatCollaboration({
  view,
  api,
  actorId,
  runtimeId,
  storage,
  openInvitation = () => undefined,
  openChat = () => undefined,
  openTerminal = () => undefined,
  openProject = () => undefined,
}: {
  view: ChatCollaborationView;
  api: CollaborationApi;
  actorId: string;
  runtimeId?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  openInvitation?: (invitationId: string) => void;
  openChat?: (scopeId: string) => void;
  openTerminal?: (scopeId: string) => void;
  openProject?: (scopeId: string) => void;
}) {
  if (view.kind === "home") {
    return <CollaborationHome api={api} openInvitation={openInvitation} openChat={openChat}
      openTerminal={openTerminal} openProject={openProject} />;
  }
  if (view.kind === "invitation") {
    return <InvitationView api={api} invitationId={view.invitationId} openChat={openChat}
      openTerminal={openTerminal} openProject={openProject} />;
  }
  if (view.kind === "terminal") return <SharedTerminalView api={api} actorId={actorId} scopeId={view.scopeId} />;
  if (view.kind === "project") return <SharedProjectView api={api} scopeId={view.scopeId} />;
  return <SharedChatView api={api} actorId={actorId} runtimeId={runtimeId ?? "platform"}
    scopeId={view.scopeId} storage={storage} />;
}

function CollaborationHome({ api, openInvitation, openChat, openTerminal, openProject }: {
  api: CollaborationApi;
  openInvitation: (invitationId: string) => void;
  openChat: (scopeId: string) => void;
  openTerminal: (scopeId: string) => void;
  openProject: (scopeId: string) => void;
}) {
  const [items, setItems] = useState<DiscoveryItem[]>([]);
  const [inboxCursor, setInboxCursor] = useState<string | null>(null);
  const [sharedCursor, setSharedCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [paginationError, setPaginationError] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([api.get("/api/collaboration/inbox"), api.get("/api/collaboration/shared")])
      .then(([inbox, shared]) => {
        if (!active) return;
        const inboxPage = CollaborationDiscoveryResponseSchema.parse(inbox);
        const sharedPage = CollaborationDiscoveryResponseSchema.parse(shared);
        setItems([
          ...inboxPage.items,
          ...sharedPage.items,
        ]);
        setInboxCursor(inboxPage.nextCursor ?? null);
        setSharedCursor(sharedPage.nextCursor ?? null);
        setError(false);
      })
      .catch((failure: unknown) => {
        console.warn("[chat-collaboration] discovery failed", failure instanceof Error ? failure.name : "UnknownError");
        if (active) setError(true);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);
  const loadMore = async () => {
    if (loadingMore || (!inboxCursor && !sharedCursor)) return;
    setLoadingMore(true);
    setPaginationError(false);
    try {
      const [inbox, shared] = await Promise.all([
        inboxCursor ? api.get(`/api/collaboration/inbox?limit=50&cursor=${encodeURIComponent(inboxCursor)}`) : null,
        sharedCursor ? api.get(`/api/collaboration/shared?limit=50&cursor=${encodeURIComponent(sharedCursor)}`) : null,
      ]);
      const inboxPage = inbox ? CollaborationDiscoveryResponseSchema.parse(inbox) : null;
      const sharedPage = shared ? CollaborationDiscoveryResponseSchema.parse(shared) : null;
      const additions = [...(inboxPage?.items ?? []), ...(sharedPage?.items ?? [])];
      setItems((current) => additions.reduce<DiscoveryItem[]>((combined, item) => (
        combined.some((existing) => discoveryKey(existing) === discoveryKey(item)) ? combined : [...combined, item]
      ), current));
      if (inboxPage) setInboxCursor(inboxPage.nextCursor ?? null);
      if (sharedPage) setSharedCursor(sharedPage.nextCursor ?? null);
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] discovery page failed", failure instanceof Error ? failure.name : "UnknownError");
      setPaginationError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-5 p-5 sm:p-8">
    <header>
      <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>Collaboration</p>
      <h1 className="mt-1 text-2xl font-semibold">Shared with me</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Invitations, Chats, terminals, and projects shared with your Matrix account.</p>
    </header>
    {loading ? <p role="status" className="rounded-2xl border p-6 text-sm">Loading shared items…</p> : null}
    {error ? <div role="alert" className="rounded-2xl border p-6">
      <p className="font-medium">Shared items are unavailable</p>
      <p className="mt-1 text-sm">Refresh the page to try again.</p>
    </div> : null}
    {!loading && !error && items.length === 0 ? <div className="rounded-2xl border p-10 text-center">
      <div aria-hidden className="text-3xl">◇</div>
      <h2 className="mt-3 text-lg font-medium">Nothing shared yet</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Invitations and accepted shared items will appear here.</p>
    </div> : null}
    <div className="grid gap-3">
      {items.map((item) => item.status === "invited"
        ? <article key={`invite:${item.invitationId}`} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{item.resource.owner.displayName} invited you</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Shared {kindLabel(item.kind)} · {roleLabel(item.resource.role)}</p>
          </div>
          <button type="button" className={buttonClass} onClick={() => openInvitation(item.invitationId)}>Review invitation</button>
        </article>
        : <article key={`scope:${item.scopeId}`} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{"chat" in item.resource
              ? item.resource.chat.title
              : "terminal" in item.resource ? item.resource.terminal.id : item.resource.project.id}</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Shared {kindLabel(item.kind)} · {roleLabel(item.resource.scope.role)}</p>
          </div>
          {"chat" in item.resource
            ? <button type="button" className={buttonClass} onClick={() => openChat(item.scopeId)}>Open Chat</button>
            : "terminal" in item.resource
              ? <button type="button" className={buttonClass} onClick={() => openTerminal(item.scopeId)}>Open terminal</button>
              : <button type="button" className={buttonClass} onClick={() => openProject(item.scopeId)}>Open project</button>}
        </article>)}
    </div>
    {paginationError ? <p role="alert" className="text-sm">More shared items could not be loaded. Try again.</p> : null}
    {inboxCursor || sharedCursor ? <button type="button" className={buttonClass} disabled={loadingMore} onClick={() => void loadMore()}>
      {loadingMore ? "Loading…" : "Load more shared items"}
    </button> : null}
  </main>;
}

function SharedTerminalView({ api, actorId, scopeId }: {
  api: CollaborationApi;
  actorId: string;
  scopeId: string;
}) {
  const [scope, setScope] = useState<SharedScope | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setScope(null);
    setFailed(false);
    void api.get(`/api/collaboration/scopes/${scopeId}`)
      .then((value) => {
        const parsed = CollaborationScopeSchema.parse(value);
        if (parsed.kind !== "terminal") throw new Error("Scope kind mismatch");
        if (active) setScope(parsed);
      })
      .catch((error: unknown) => {
        console.warn("[terminal-collaboration] scope load failed", error instanceof Error ? error.name : "UnknownError");
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [api, scopeId]);
  if (failed) return <SafeError title="Shared terminal unavailable" />;
  if (!scope) return <p role="status" className="p-8">Loading shared terminal…</p>;
  return <SharedTerminalControls api={api} scope={scope} actorId={actorId} />;
}

function SharedProjectView({ api, scopeId }: { api: CollaborationApi; scopeId: string }) {
  const [value, setValue] = useState<{ scope: SharedScope; project: z.infer<typeof CollaborationProjectSchema> } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setValue(null);
    setFailed(false);
    const base = `/api/collaboration/scopes/${scopeId}`;
    void Promise.all([api.get(base), api.get(`${base}/project`)])
      .then(([scopeValue, projectValue]) => {
        const scope = CollaborationScopeSchema.parse(scopeValue);
        const project = CollaborationProjectSchema.parse(projectValue);
        if (scope.kind !== "project" || project.scopeId !== scope.id || project.id !== scope.resourceId) {
          throw new Error("Project scope mismatch");
        }
        if (active) setValue({ scope, project });
      })
      .catch((error: unknown) => {
        console.warn("[project-collaboration] project load failed", error instanceof Error ? error.name : "UnknownError");
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [api, scopeId]);
  if (failed) return <SafeError title="Shared project unavailable" />;
  if (!value) return <p role="status" className="p-8">Loading shared project…</p>;
  return <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5 p-5 sm:p-8">
    <header>
      <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>Shared project</p>
      <h1 className="mt-1 text-2xl font-semibold">{value.project.id}</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        {roleLabel(value.scope.role)} · {value.scope.role === "viewer" ? "read only" : "can edit"}
      </p>
    </header>
    {value.project.status === "archived" ? <p role="status" className="rounded-xl border p-4 text-sm">This project is archived.</p> : null}
    <section aria-labelledby="shared-project-contents">
      <h2 id="shared-project-contents" className="font-medium">Project contents</h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {value.project.resources.map((resource) => <li key={`${resource.kind}:${resource.id}`}
          className="rounded-xl border px-3 py-2 text-sm">
          <span className="font-medium">{resource.id}</span>
          <span className="ml-2 capitalize" style={{ color: "var(--text-secondary)" }}>{resource.kind}</span>
        </li>)}
      </ul>
    </section>
  </main>;
}

function discoveryKey(item: DiscoveryItem): string {
  return item.status === "invited" ? `invite:${item.invitationId}` : `scope:${item.scopeId}`;
}

function InvitationView({ api, invitationId, openChat, openTerminal, openProject }: {
  api: CollaborationApi;
  invitationId: string;
  openChat: (scopeId: string) => void;
  openTerminal: (scopeId: string) => void;
  openProject: (scopeId: string) => void;
}) {
  const [invitation, setInvitation] = useState<z.infer<typeof CollaborationInvitationSchema> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void api.get(`/api/collaboration/invitations/${encodeURIComponent(invitationId)}`)
      .then((value) => { if (active) setInvitation(CollaborationInvitationSchema.parse(value)); })
      .catch((failure: unknown) => {
        console.warn("[chat-collaboration] invitation load failed", failure instanceof Error ? failure.name : "UnknownError");
        if (active) setError(true);
      });
    return () => { active = false; };
  }, [api, invitationId]);
  const accept = async () => {
    if (!invitation) return;
    setPending(true); setError(false);
    try {
      const result = z.looseObject({ scopeId: z.uuid() }).parse(await api.post(
        `/api/collaboration/invitations/${encodeURIComponent(invitation.id)}/accept`,
        { clientRequestId: crypto.randomUUID(), expectedRevision: invitation.revision },
      ));
      if (invitation.scopeKind === "terminal") openTerminal(result.scopeId);
      else if (invitation.scopeKind === "project") openProject(result.scopeId);
      else openChat(result.scopeId);
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] invitation acceptance failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally { setPending(false); }
  };
  if (error && !invitation) return <SafeError title="Invitation unavailable" />;
  if (!invitation) return <p role="status" className="p-8">Loading invitation…</p>;
  return <main className="mx-auto flex min-h-full w-full max-w-2xl items-center p-5 sm:p-8">
    <section className="w-full rounded-2xl border p-6 sm:p-8">
      <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>{kindLabel(invitation.scopeKind)} invitation</p>
      <h1 className="mt-2 text-2xl font-semibold">Join this shared {kindLabel(invitation.scopeKind)}?</h1>
      <p className="mt-3">{invitation.owner.displayName} invited you as an {invitation.role}.</p>
      <div className="mt-5 rounded-xl border p-4 text-sm">
        <p className="font-medium">What you’ll get</p>
        <p className="mt-1" style={{ color: "var(--text-secondary)" }}>{invitation.scopeKind === "terminal"
          ? "Access to this terminal’s retained and live output, with input control when your role permits."
          : invitation.scopeKind === "project"
            ? "Access to the complete project inventory, including future project-owned contents."
            : "Access to this ongoing Chat’s history, human discussion, and its ordered AI queue when shared AI is available."}</p>
        <p className="mt-3 font-medium">What stays private</p>
        <p className="mt-1" style={{ color: "var(--text-secondary)" }}>{invitation.scopeKind === "project"
          ? "External references, personal presentation state, credentials, and unrelated resources stay private."
          : "This does not include its project, sibling Chats or terminals, files, apps, or anyone’s private state."}</p>
      </div>
      <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>{invitation.scopeKind === "terminal"
        ? "Owners and editors can request input control. Viewers watch only, and no role can create sibling terminals from this share."
        : "Editors can discuss and request AI. Viewers remain read-only. Owners decide any AI approvals."}</p>
      {error ? <p role="alert" className="mt-4 text-sm">Invitation could not be accepted. Refresh and try again.</p> : null}
      <button type="button" className={`${buttonClass} mt-6 w-full`} disabled={pending || invitation.status !== "pending"} onClick={() => void accept()}>
        {pending ? "Accepting…" : invitation.status === "pending" ? "Accept invitation" : "Invitation unavailable"}
      </button>
    </section>
  </main>;
}

type SharedScope = z.infer<typeof CollaborationScopeSchema>;
type SharedChat = z.infer<typeof CollaborationChatSchema>;
type SharedChatError = "load" | "send" | "unavailable" | null;

class CollaborationRecoverySupersededError extends Error {
  constructor() {
    super("CollaborationRecoverySuperseded");
    this.name = "CollaborationRecoverySupersededError";
  }
}

interface SharedChatState {
  scope: SharedScope | null;
  chat: SharedChat | null;
  messages: SharedMessage[];
  hasMoreMessages: boolean;
  loadingMoreMessages: boolean;
  historyPageError: boolean;
  draft: CollaborationDraft;
  loading: boolean;
  sending: boolean;
  error: SharedChatError;
  refreshVersion: number;
}

type SharedChatAction =
  | { type: "reset" }
  | { type: "loaded"; scope: SharedScope; chat: SharedChat; messages: SharedMessage[]; clearForegroundError: boolean }
  | { type: "load_failed" }
  | { type: "page_started" }
  | { type: "page_cancelled" }
  | { type: "page_loaded"; messages: SharedMessage[]; hasMore: boolean }
  | { type: "page_failed" }
  | { type: "recovery_failed" }
  | { type: "draft_changed"; draft: CollaborationDraft }
  | { type: "send_started" }
  | { type: "send_finished" }
  | { type: "send_failed" }
  | { type: "unavailable" };

const initialSharedChatState: SharedChatState = {
  scope: null,
  chat: null,
  messages: [],
  hasMoreMessages: false,
  loadingMoreMessages: false,
  historyPageError: false,
  draft: { text: "", mode: "discussion" },
  loading: true,
  sending: false,
  error: null,
  refreshVersion: 0,
};

function reduceSharedChat(state: SharedChatState, action: SharedChatAction): SharedChatState {
  switch (action.type) {
    case "reset": return initialSharedChatState;
    case "loaded":
      return { ...state, scope: action.scope, chat: action.chat, messages: action.messages,
        hasMoreMessages: BigInt(action.chat.messageCount) > BigInt(action.messages.length),
        loadingMoreMessages: false, historyPageError: false, loading: false,
        refreshVersion: state.refreshVersion + 1,
        error: action.clearForegroundError || state.error === "load" || state.error === "unavailable" ? null : state.error };
    case "load_failed": return { ...state, loading: false, error: "load" };
    case "page_started": return { ...state, loadingMoreMessages: true, historyPageError: false };
    case "page_cancelled": return { ...state, loadingMoreMessages: false };
    case "page_loaded": return { ...state, messages: action.messages, hasMoreMessages: action.hasMore,
      loadingMoreMessages: false, historyPageError: false };
    case "page_failed": return { ...state, loadingMoreMessages: false, historyPageError: true };
    case "recovery_failed": return { ...state, loadingMoreMessages: false };
    case "draft_changed": return { ...state, draft: action.draft };
    case "send_started": return { ...state, sending: true, error: null };
    case "send_finished": return { ...state, sending: false };
    case "send_failed": return { ...state, sending: false, error: "send" };
    case "unavailable": return { ...state, error: "unavailable" };
  }
}

function useSharedChatController({ api, actorId, runtimeId, scopeId, storage }: {
  api: CollaborationApi;
  actorId: string;
  runtimeId: string;
  scopeId: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}) {
  const [state, dispatch] = useReducer(reduceSharedChat, initialSharedChatState);
  const loadGeneration = useRef(0);
  const recoveryGeneration = useRef<number | null>(null);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const draftStore = useMemo(() => createCollaborationDraftStore(storage ?? browserStorage()), [storage]);
  const draftKey = useMemo(() => collaborationDraftKey({
    actorId, runtimeId, scopeId, chatId: state.scope?.resourceId ?? "pending_chat",
  }), [actorId, runtimeId, state.scope?.resourceId, scopeId]);
  const load = useCallback(async (clearForegroundError = false) => {
    const generation = ++loadGeneration.current;
    const base = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
    try {
      const [scopeValue, chatValue, messagesValue] = await Promise.all([
        api.get(base), api.get(`${base}/chat`), api.get(`${base}/chat/messages?after=0&limit=100`),
      ]);
      const nextScope = CollaborationScopeSchema.parse(scopeValue);
      const nextChat = CollaborationChatSchema.parse(chatValue);
      const nextMessages = CollaborationChatMessagesResponseSchema.parse(messagesValue).messages;
      if (generation !== loadGeneration.current) return;
      dispatch({ type: "loaded", scope: nextScope, chat: nextChat, messages: nextMessages, clearForegroundError });
      markRead(api, base, nextMessages);
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] Chat load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === loadGeneration.current) dispatch({ type: "load_failed" });
    }
  }, [api, scopeId]);
  const recoverCanonical = useCallback(async () => {
    // Fence pending history pages and older refreshes before reading canonical state.
    const generation = ++loadGeneration.current;
    recoveryGeneration.current = generation;
    dispatch({ type: "page_started" });
    try {
      const base = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
      const [scopeValue, chatValue] = await Promise.all([api.get(base), api.get(`${base}/chat`)]);
      const nextScope = CollaborationScopeSchema.parse(scopeValue);
      const nextChat = CollaborationChatSchema.parse(chatValue);
      let combined: SharedMessage[] = [];
      const targetCount = BigInt(nextChat.messageCount);
      while (BigInt(combined.length) < targetCount) {
        const after = combined.at(-1)?.sequence ?? "0";
        const page = CollaborationChatMessagesResponseSchema.parse(await api.get(
          `${base}/chat/messages?after=${encodeURIComponent(after)}&limit=100`,
        )).messages;
        const additions = page.filter((message) => !combined.some((existing) => existing.id === message.id));
        if (additions.length === 0) throw new Error("CollaborationRecoveryIncomplete");
        combined = [...combined, ...additions];
      }
      if (generation !== loadGeneration.current) throw new CollaborationRecoverySupersededError();
      dispatch({ type: "loaded", scope: nextScope, chat: nextChat, messages: combined, clearForegroundError: false });
      markRead(api, base, combined);
    } catch (failure: unknown) {
      if (generation === loadGeneration.current) dispatch({ type: "recovery_failed" });
      throw failure;
    } finally {
      if (recoveryGeneration.current === generation) {
        recoveryGeneration.current = null;
        dispatch({ type: "page_cancelled" });
      }
    }
  }, [api, scopeId]);
  useEffect(() => {
    dispatch({ type: "reset" });
    void load(true);
    return () => { loadGeneration.current += 1; recoveryGeneration.current = null; };
  }, [load]);
  const loadMoreMessages = async () => {
    const after = state.messages.at(-1)?.sequence;
    if (!after || !state.chat || state.loadingMoreMessages || recoveryGeneration.current !== null) return;
    const generation = loadGeneration.current;
    dispatch({ type: "page_started" });
    try {
      const next = CollaborationChatMessagesResponseSchema.parse(await api.get(
        `/api/collaboration/scopes/${encodeURIComponent(scopeId)}/chat/messages?after=${encodeURIComponent(after)}&limit=100`,
      )).messages;
      if (generation !== loadGeneration.current) return;
      const current = stateRef.current;
      const appended = next.filter((message) => !current.messages.some((existing) => existing.id === message.id));
      const combined = [...current.messages, ...appended];
      dispatch({ type: "page_loaded", messages: combined,
        hasMore: appended.length > 0 && BigInt(current.chat?.messageCount ?? "0") > BigInt(combined.length) });
      markRead(api, `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`, combined);
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] history page failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === loadGeneration.current) dispatch({ type: "page_failed" });
    }
  };
  useEffect(() => {
    if (!state.scope) return;
    const key = collaborationDraftKey({ actorId, runtimeId, scopeId, chatId: state.scope.resourceId });
    dispatch({ type: "draft_changed", draft: draftStore.load(key) });
  }, [actorId, draftStore, runtimeId, state.scope, scopeId]);
  useEffect(() => api.subscribe?.(scopeId, recoverCanonical, () => dispatch({ type: "unavailable" })), [api, recoverCanonical, scopeId]);
  const updateDraft = (text: string, mode: CollaborationDraft["mode"] = state.draft.mode) => {
    const next = { text, mode };
    dispatch({ type: "draft_changed", draft: next });
    if (state.scope) draftStore.save(collaborationDraftModeKey(draftKey, mode), next);
  };
  const changeDraftMode = (mode: CollaborationDraft["mode"]) => {
    dispatch({ type: "draft_changed", draft: draftStore.load(collaborationDraftModeKey(draftKey, mode), mode) });
  };
  const send = async () => {
    if (!state.scope || state.draft.mode !== "discussion" || !state.draft.text.trim()
      || !deriveChatPermissions(state.scope).canDiscuss) return;
    dispatch({ type: "send_started" });
    try {
      await api.post(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}/chat/messages`, {
        clientRequestId: crypto.randomUUID(), expectedRevision: state.scope.revision, text: state.draft.text.trim(),
      });
      draftStore.clear(draftKey);
      dispatch({ type: "draft_changed", draft: { text: "", mode: "discussion" } });
      dispatch({ type: "send_finished" });
      try {
        await recoverCanonical();
      } catch (failure: unknown) {
        if (failure instanceof CollaborationRecoverySupersededError) return;
        console.warn("[chat-collaboration] sent message refresh failed", failure instanceof Error ? failure.name : "UnknownError");
        dispatch({ type: "load_failed" });
      }
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] discussion send failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "send_failed" });
      return;
    }
  };
  return { state, loadMoreMessages, updateDraft, changeDraftMode, send };
}

function SharedChatView(props: Parameters<typeof useSharedChatController>[0]) {
  const { state, loadMoreMessages, updateDraft, changeDraftMode, send } = useSharedChatController(props);
  if (state.loading) return <p role="status" className="p-8">Loading shared Chat…</p>;
  if (!state.scope || !state.chat || state.error === "load" || state.error === "unavailable") {
    return <SafeError title="Shared Chat unavailable" />;
  }
  const permissions = deriveChatPermissions(state.scope);
  return <main className="mx-auto flex h-full min-h-[32rem] w-full max-w-4xl flex-col">
    <header className="border-b p-4 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-lg font-semibold">{state.chat.title}</h1>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Shared Chat · {permissions.roleLabel}</p></div>
        <span className="rounded-full border px-2.5 py-1 text-xs">Live collaboration</span>
      </div>
    </header>
    <SharedChatHistory state={state} loadMoreMessages={loadMoreMessages} />
    <SharedChatControls key={state.scope.id} api={props.api} scope={state.scope} actorId={props.actorId}
      resourceRevision={state.chat.revision} draft={state.draft} updateDraft={updateDraft}
      changeDraftMode={changeDraftMode}
      discussionSending={state.sending} discussionError={state.error === "send"}
      sendDiscussion={send} refreshVersion={state.refreshVersion} />
  </main>;
}

function SharedChatHistory({ state, loadMoreMessages }: {
  state: SharedChatState;
  loadMoreMessages: () => Promise<void>;
}) {
  return <section aria-label="Chat history" className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
    {state.messages.length === 0 ? <div className="py-12 text-center">
      <div aria-hidden className="text-3xl">◇</div><h2 className="mt-3 font-medium">Start the discussion</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Messages here are visible to everyone in this shared Chat.</p>
    </div> : state.messages.map((message) => <SharedMessageView key={message.id} message={message} />)}
    {state.historyPageError ? <p role="alert" className="text-center text-sm">More messages could not be loaded. Try again.</p> : null}
    {state.hasMoreMessages ? <div className="text-center"><button type="button" className={buttonClass}
      disabled={state.loadingMoreMessages} onClick={() => void loadMoreMessages()}>
      {state.loadingMoreMessages ? "Loading…" : "Load more messages"}
    </button></div> : null}
  </section>;
}

function markRead(api: CollaborationApi, base: string, messages: readonly SharedMessage[]): void {
  const sequence = messages.at(-1)?.sequence;
  if (!sequence || !api.patch) return;
  void api.patch(`${base}/user-state`, { readThroughSeq: sequence }).catch((failure: unknown) => {
    console.warn("[chat-collaboration] read state update failed", failure instanceof Error ? failure.name : "UnknownError");
  });
}

function SharedMessageView({ message }: { message: SharedMessage }) {
  const attachments: ChatMessageAttachment[] = message.parts.flatMap((part) => part.type === "attachment_reference"
    ? [{ id: part.attachmentId, label: part.label, kind: part.kind === "image" ? "image" as const : "file" as const }]
    : []);
  const texts = keyedValues(message.parts.flatMap((part) => part.type === "text" || part.type === "summary" ? [part.text] : []), "text");
  const notices = keyedValues(message.parts.flatMap((part) => part.type === "status" ? [part.detail ?? part.label]
    : part.type === "tool_request" ? [`Tool request: ${part.label}`]
      : part.type === "tool_result" ? [part.text ?? `Tool ${part.outcome}`] : []), "notice");
  return <article className="rounded-2xl border p-4">
    <header className="mb-2 flex items-center justify-between gap-3">
      <span className="font-medium">{message.actor.displayName}</span>
      <time className="text-xs" style={{ color: "var(--text-tertiary)" }} dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
    </header>
    <div className="prose prose-sm max-w-none break-words">
      {texts.map((item) => <ReactMarkdown key={item.key} remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl}>{item.value}</ReactMarkdown>)}
      {notices.map((item) => <p key={item.key} className="text-sm" style={{ color: "var(--text-secondary)" }}>{item.value}</p>)}
    </div>
    {attachments.length > 0 ? <div className="mt-3"><ChatAttachments attachments={attachments} /></div> : null}
  </article>;
}

function SafeError({ title }: { title: string }) {
  return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
    <div aria-hidden className="text-3xl">◇</div><h1 className="mt-3 text-lg font-medium">{title}</h1>
    <p className="mt-1 text-sm">Your access may have changed. Return to Shared with me and refresh.</p>
  </div>;
}

function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : "";
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[chat-collaboration] link validation failed", "UnknownError");
    return "";
  }
}

const noopStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

function browserStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try { return typeof window === "undefined" ? noopStorage : window.localStorage; }
  catch (error: unknown) {
    console.warn("[chat-collaboration] private draft storage unavailable", error instanceof Error ? error.name : "UnknownError");
    return noopStorage;
  }
}

function roleLabel(role: "owner" | "editor" | "viewer"): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

function kindLabel(kind: "chat" | "terminal" | "project"): string {
  return kind === "chat" ? "Chat" : kind === "terminal" ? "terminal" : "project";
}

const messageTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatTime(value: string): string {
  return messageTimeFormatter.format(new Date(value));
}

function keyedValues(values: readonly string[], kind: string): Array<{ key: string; value: string }> {
  // Message parts are contract-capped at 64; a plain record avoids retaining
  // collection state beyond this render.
  const occurrences: Record<string, number> = Object.create(null) as Record<string, number>;
  return values.map((value) => {
    const occurrence = (occurrences[value] ?? 0) + 1;
    occurrences[value] = occurrence;
    return { key: `${kind}:${value}:${occurrence}`, value };
  });
}

const buttonClass = "rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";
