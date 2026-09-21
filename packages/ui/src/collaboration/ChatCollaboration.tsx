import {
  CollaborationChatMessagesResponseSchema,
  CollaborationChatSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationDiscoveryItemSchema,
  CollaborationInvitationSchema,
  CollaborationMemberSchema,
  CollaborationProjectSchema,
  CollaborationScopeSchema,
  CollaborationSharedChatMessageSchema,
  type CanonicalChatMessagePart,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { collaborationDraftKey, collaborationDraftModeKey, createCollaborationDraftStore, type CollaborationDraft } from "./chat-state.js";
import { deriveChatPermissions } from "./permissions.js";
import { SharedChatControls } from "./SharedChatControls.js";
import { SharedTerminalControls } from "./SharedTerminalControls.js";
import { projectSharedChatTimeline } from "./chat-projection.js";
import { SessionAccessControl } from "./SessionAccessControl.js";
import { SessionDiscussionLayer, type CollaborationOverlayLayers } from "./SessionDiscussionLayer.js";
import { useSessionDiscussion } from "./useSessionDiscussion.js";
import { notifyCollaborationDiscoveryChanged } from "./discovery-events.js";

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryItemSchema>;
type SharedMessage = z.infer<typeof CollaborationSharedChatMessageSchema>;

export type ChatCollaborationView =
  | { kind: "home" }
  | { kind: "invitation"; invitationId: string }
  | { kind: "chat"; scopeId: string }
  | { kind: "canonical-chat"; chatId: string }
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
  onChatMetadata,
  headerContainer,
  layers,
}: {
  view: ChatCollaborationView;
  api: CollaborationApi;
  actorId: string;
  runtimeId?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  openInvitation?: (invitationId: string) => void;
  openChat?: (scopeId: string, chatId?: string, title?: string) => void;
  openTerminal?: (scopeId: string) => void;
  openProject?: (scopeId: string) => void;
  onChatMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  headerContainer?: HTMLElement | null;
  layers?: CollaborationOverlayLayers;
}) {
  if (view.kind === "home") {
    return <CollaborationHome api={api} openInvitation={openInvitation} openChat={openChat}
      openTerminal={openTerminal} openProject={openProject} />;
  }
  if (view.kind === "invitation") {
    return <InvitationView api={api} invitationId={view.invitationId} openChat={openChat}
      openTerminal={openTerminal} openProject={openProject} />;
  }
  if (view.kind === "terminal") return <SharedTerminalView api={api} actorId={actorId} scopeId={view.scopeId} layers={layers} />;
  if (view.kind === "project") return <SharedProjectView api={api} scopeId={view.scopeId} />;
  if (view.kind === "canonical-chat") return <CanonicalSharedChatPanel api={api} actorId={actorId}
    runtimeId={runtimeId ?? "platform"} chatId={view.chatId} storage={storage} onMetadata={onChatMetadata}
    headerContainer={headerContainer} layers={layers} />;
  return <SharedChatPanel api={api} actorId={actorId} runtimeId={runtimeId ?? "platform"}
    scopeId={view.scopeId} storage={storage} onMetadata={onChatMetadata} headerContainer={headerContainer} layers={layers} />;
}

function CollaborationHome({ api, openInvitation, openChat, openTerminal, openProject }: {
  api: CollaborationApi;
  openInvitation: (invitationId: string) => void;
  openChat: (scopeId: string, chatId?: string, title?: string) => void;
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
  const [invitationPending, setInvitationPending] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState(false);
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
  const actOnInvitation = async (item: Extract<DiscoveryItem, { status: "invited" }>, action: "accept" | "decline") => {
    if (invitationPending || !item.resource) return;
    setInvitationPending(item.invitationId);
    setInvitationError(false);
    try {
      const result = z.looseObject({ scopeId: z.uuid() }).parse(await api.post(
        `/api/collaboration/invitations/${encodeURIComponent(item.invitationId)}/${action}`,
        { clientRequestId: crypto.randomUUID(), expectedRevision: item.resource.revision },
      ));
      setItems((current) => current.filter((candidate) => discoveryKey(candidate) !== discoveryKey(item)));
      notifyCollaborationDiscoveryChanged();
      if (action === "accept") {
        if (item.kind === "terminal") openTerminal(result.scopeId);
        else if (item.kind === "project") openProject(result.scopeId);
        else openChat(result.scopeId);
      }
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] invitation action failed", failure instanceof Error ? failure.name : "UnknownError");
      setInvitationError(true);
    } finally {
      setInvitationPending(null);
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
      {items.map((item) => item.status === "organization_pending"
        ? <article key={`org:${item.scopeId}`} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Shared with your organization</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Shared {kindLabel(item.kind)} · opens when you join</p>
          </div>
          <button type="button" className={buttonClass} onClick={() => item.kind === "terminal" ? openTerminal(item.scopeId) : item.kind === "project" ? openProject(item.scopeId) : openChat(item.scopeId)}>Open</button>
        </article>
        : !item.resource
        ? <article key={discoveryKey(item)} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{item.status === "invited" ? "Invitation" : `Shared ${kindLabel(item.kind)}`}</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{item.home === "denied" ? "Access is no longer available." : "The owner's computer is offline. Try again later."}</p>
          </div>
        </article>
        : item.status === "invited"
        ? <article key={`invite:${item.invitationId}`} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{item.resource.owner.displayName} invited you</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Shared {kindLabel(item.kind)} · {roleLabel(item.resource.role)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={invitationPending !== null}
              onClick={() => void actOnInvitation(item, "accept")}>Accept</button>
            <button type="button" className={buttonClass} disabled={invitationPending !== null}
              onClick={() => void actOnInvitation(item, "decline")}>Decline</button>
            <button type="button" className={buttonClass} disabled={invitationPending !== null}
              onClick={() => openInvitation(item.invitationId)}>Details</button>
          </div>
        </article>
        : <article key={`scope:${item.scopeId}`} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{"chat" in item.resource
              ? item.resource.chat.title
              : "terminal" in item.resource ? item.resource.terminal.id : item.resource.project.id}</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Shared {kindLabel(item.kind)} · {roleLabel(item.resource.scope.role)}</p>
          </div>
          {"chat" in item.resource
            ? <button type="button" className={buttonClass} onClick={() => openAcceptedChat(item, openChat)}>Open Chat</button>
            : "terminal" in item.resource
              ? <button type="button" className={buttonClass} onClick={() => openTerminal(item.scopeId)}>Open terminal</button>
              : <button type="button" className={buttonClass} onClick={() => openProject(item.scopeId)}>Open project</button>}
        </article>)}
    </div>
    {invitationError ? <p role="alert" className="text-sm">Invitation could not be updated. Try again.</p> : null}
    {paginationError ? <p role="alert" className="text-sm">More shared items could not be loaded. Try again.</p> : null}
    {inboxCursor || sharedCursor ? <button type="button" className={buttonClass} disabled={loadingMore} onClick={() => void loadMore()}>
      {loadingMore ? "Loading…" : "Load more shared items"}
    </button> : null}
  </main>;
}

function SharedTerminalView({ api, actorId, scopeId, layers }: {
  api: CollaborationApi;
  actorId: string;
  scopeId: string;
  layers?: CollaborationOverlayLayers;
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
  return <SharedTerminalControls api={api} scope={scope} actorId={actorId} layers={layers} />;
}

function SharedProjectView({ api, scopeId }: { api: CollaborationApi; scopeId: string }) {
  const [value, setValue] = useState<{ scope: SharedScope; project: z.infer<typeof CollaborationProjectSchema> } | null>(null);
  const [failed, setFailed] = useState(false);
  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const base = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}`;
    try {
      const [scopeValue, projectValue] = await Promise.all([api.get(base), api.get(`${base}/project`)]);
      const scope = CollaborationScopeSchema.parse(scopeValue);
      const project = CollaborationProjectSchema.parse(projectValue);
      if (scope.kind !== "project" || project.scopeId !== scope.id || project.id !== scope.resourceId) {
        throw new Error("Project scope mismatch");
      }
      if (generation === loadGeneration.current) {
        setValue({ scope, project });
        setFailed(false);
      }
    } catch (error: unknown) {
      console.warn("[project-collaboration] project load failed", error instanceof Error ? error.name : "UnknownError");
      if (generation === loadGeneration.current) {
        setValue(null);
        setFailed(true);
      }
      throw error;
    }
  }, [api, scopeId]);
  useEffect(() => {
    setValue(null);
    setFailed(false);
    void load().catch((error: unknown) => {
      console.warn("[project-collaboration] initial load unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { loadGeneration.current += 1; };
  }, [load]);
  useEffect(() => api.subscribe?.(scopeId, load, () => {
    loadGeneration.current += 1;
    setValue(null);
    setFailed(true);
  }), [api, load, scopeId]);
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
  if (item.status === "invited") return `invite:${item.invitationId}`;
  return item.status === "organization_pending" ? `org:${item.scopeId}` : `scope:${item.scopeId}`;
}

function openAcceptedChat(
  item: DiscoveryItem,
  openChat: (scopeId: string, chatId?: string, title?: string) => void,
): void {
  if (item.status !== "accepted" || !item.resource || !("chat" in item.resource)) return;
  openChat(item.scopeId, item.resource.chat.id, item.resource.chat.title);
}

function InvitationView({ api, invitationId, openChat, openTerminal, openProject }: {
  api: CollaborationApi;
  invitationId: string;
  openChat: (scopeId: string, chatId?: string, title?: string) => void;
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
  const act = async (action: "accept" | "decline") => {
    if (!invitation) return;
    setPending(true); setError(false);
    try {
      const result = z.looseObject({ scopeId: z.uuid() }).parse(await api.post(
        `/api/collaboration/invitations/${encodeURIComponent(invitation.id)}/${action}`,
        { clientRequestId: crypto.randomUUID(), expectedRevision: invitation.revision },
      ));
      notifyCollaborationDiscoveryChanged();
      if (action === "accept") {
        if (invitation.scopeKind === "terminal") openTerminal(result.scopeId);
        else if (invitation.scopeKind === "project") openProject(result.scopeId);
        else openChat(result.scopeId);
      } else {
        setInvitation((current) => current ? { ...current, status: "revoked" } : current);
      }
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] invitation action failed", failure instanceof Error ? failure.name : "UnknownError");
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
      {invitation.status === "revoked" ? <p role="status" className="mt-4 text-sm">Invitation declined.</p> : null}
      {error ? <p role="alert" className="mt-4 text-sm">Invitation could not be updated. Refresh and try again.</p> : null}
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        <button type="button" className={buttonClass} disabled={pending || invitation.status !== "pending"} onClick={() => void act("accept")}>
          {pending ? "Updating…" : invitation.status === "pending" ? "Accept invitation" : "Invitation unavailable"}
        </button>
        <button type="button" className={buttonClass} disabled={pending || invitation.status !== "pending"} onClick={() => void act("decline")}>
          Decline invitation
        </button>
      </div>
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
  connection: "connecting" | "connected" | "reconnecting";
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
  | { type: "connection_changed"; connection: SharedChatState["connection"] }
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
  connection: "connecting",
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
    case "connection_changed": return { ...state, connection: action.connection };
    case "unavailable": return { ...state, error: "unavailable" };
  }
}

function useSharedChatController({ api, actorId, runtimeId, scopeId, storage, onMetadata }: {
  api: CollaborationApi;
  actorId: string;
  runtimeId: string;
  scopeId: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  onMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
}) {
  const [state, dispatch] = useReducer(reduceSharedChat, initialSharedChatState);
  const loadGeneration = useRef(0);
  const recoveryGeneration = useRef<number | null>(null);
  const onMetadataRef = useRef(onMetadata);
  useEffect(() => { onMetadataRef.current = onMetadata; }, [onMetadata]);
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
      onMetadataRef.current?.({ title: nextChat.title, role: nextScope.role });
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
      onMetadataRef.current?.({ title: nextChat.title, role: nextScope.role });
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
    dispatch({ type: "draft_changed", draft: draftStore.load(collaborationDraftModeKey(key, "ai"), "ai") });
  }, [actorId, draftStore, runtimeId, state.scope, scopeId]);
  useEffect(() => api.subscribe?.(
    scopeId,
    recoverCanonical,
    () => dispatch({ type: "unavailable" }),
    (connection) => dispatch({ type: "connection_changed", connection }),
  ), [api, recoverCanonical, scopeId]);
  const updateDraft = (text: string, mode: CollaborationDraft["mode"] = state.draft.mode) => {
    const next = { text, mode };
    dispatch({ type: "draft_changed", draft: next });
    if (state.scope) draftStore.save(collaborationDraftModeKey(draftKey, mode), next);
  };
  const changeDraftMode = (mode: CollaborationDraft["mode"]) => {
    draftStore.saveSelectedMode(draftKey, mode);
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

export function SharedChatPanel(props: Parameters<typeof useSharedChatController>[0] & {
  onMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  headerContainer?: HTMLElement | null;
  layers?: CollaborationOverlayLayers;
}) {
  const { state, loadMoreMessages, updateDraft, changeDraftMode, send } = useSharedChatController(props);
  if (state.loading) return <p role="status" className="p-8">Loading shared Chat…</p>;
  if (!state.scope || !state.chat || state.error === "load" || state.error === "unavailable") {
    return <SafeError title="Shared Chat unavailable" />;
  }
  return <NativeSharedChatPanel {...props} state={{ ...state, scope: state.scope, chat: state.chat }} loadMoreMessages={loadMoreMessages}
    updateDraft={updateDraft} changeDraftMode={changeDraftMode} send={send} />;
}

function NativeSharedChatPanel({ api, actorId, runtimeId, storage, state, loadMoreMessages, updateDraft, changeDraftMode, send,
  headerContainer, layers }: {
  api: CollaborationApi;
  actorId: string;
  runtimeId: string;
  scopeId: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  state: SharedChatState & { scope: NonNullable<SharedChatState["scope"]>; chat: NonNullable<SharedChatState["chat"]> };
  loadMoreMessages(): Promise<void>;
  updateDraft(text: string, mode?: CollaborationDraft["mode"]): void;
  changeDraftMode(mode: CollaborationDraft["mode"]): void;
  send(): Promise<void>;
  headerContainer?: HTMLElement | null;
  layers?: CollaborationOverlayLayers;
}) {
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const discussionTrigger = useRef<HTMLButtonElement>(null);
  const discussion = useSessionDiscussion({ api, scope: state.scope, actorId, runtimeId, open: discussionOpen, storage });
  const closeDiscussion = useCallback(() => {
    setDiscussionOpen(false);
    queueMicrotask(() => discussionTrigger.current?.focus());
  }, []);
  const collaborationChrome = <div className="flex items-center justify-end gap-1">
      {state.connection !== "connected" ? <span role="status" className="sr-only sm:not-sr-only sm:px-2 sm:text-xs sm:text-muted-foreground">
        {state.connection === "reconnecting" ? "Reconnecting…" : "Connecting…"}
      </span> : null}
      <button ref={discussionTrigger} type="button" aria-label={discussionOpen ? "Close discussion" : "Open discussion"} aria-expanded={discussionOpen}
        onClick={() => setDiscussionOpen((current) => !current)} className="rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--bg-hover)]">
        <span className="hidden sm:inline">Discussion</span><span aria-hidden className="sm:hidden">Notes</span>
        {BigInt(discussion.latestSequence) > BigInt(0) ? <span className="ml-1" aria-label="Discussion has notes">•</span> : null}
      </button>
      <SessionAccessControl key={state.scope.id} api={api} scope={state.scope} zIndex={layers?.popover} />
    </div>;
  return <main data-slot="native-shared-chat" className="relative mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col overflow-hidden">
    {headerContainer
      ? createPortal(collaborationChrome, headerContainer)
      : <div data-slot="collaboration-session-subheader" className="flex min-h-11 items-center justify-end border-b px-3">
        {collaborationChrome}
      </div>}
    <SharedChatHistory state={state} loadMoreMessages={loadMoreMessages} />
    <SharedChatControls key={state.scope.id} api={api} scope={state.scope} actorId={actorId}
      resourceRevision={state.chat.revision} draft={state.draft} updateDraft={updateDraft}
      changeDraftMode={changeDraftMode} discussionSending={state.sending} discussionError={state.error === "send"}
      sendDiscussion={send} refreshVersion={state.refreshVersion} />
    <SessionDiscussionLayer open={discussionOpen} onClose={closeDiscussion} discussion={discussion} zIndex={layers?.dialog} />
  </main>;
}

export function CanonicalSharedChatPanel({ api, actorId, runtimeId, chatId, storage, onMetadata, headerContainer, layers }: {
  api: CollaborationApi;
  actorId: string;
  runtimeId: string;
  chatId: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  onMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  headerContainer?: HTMLElement | null;
  layers?: CollaborationOverlayLayers;
}) {
  const [resolution, setResolution] = useState<{
    chatId: string;
    scopeId: string | null;
    loading: boolean;
  }>(() => ({ chatId, scopeId: null, loading: true }));
  useEffect(() => {
    let current = true;
    setResolution({ chatId, scopeId: null, loading: true });
    void resolveCanonicalChatScope(api, chatId).then((scopeId) => {
      if (current) setResolution({ chatId, scopeId, loading: false });
    }).catch((error: unknown) => {
      console.warn("[chat-collaboration] canonical scope resolution failed",
        error instanceof Error ? error.name : "UnknownError");
      if (current) setResolution({ chatId, scopeId: null, loading: false });
    });
    return () => { current = false; };
  }, [api, chatId]);
  if (resolution.chatId !== chatId || resolution.loading) {
    return <p role="status" className="p-8">Loading shared Chat…</p>;
  }
  if (!resolution.scopeId) return <SafeError title="Shared Chat unavailable" />;
  return <SharedChatPanel api={api} actorId={actorId} runtimeId={runtimeId}
    scopeId={resolution.scopeId} storage={storage} onMetadata={onMetadata} headerContainer={headerContainer} layers={layers} />;
}

async function resolveCanonicalChatScope(api: CollaborationApi, chatId: string): Promise<string | null> {
  let cursor: string | undefined;
  const seenCursors = Object.create(null) as Record<string, true | undefined>;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page = CollaborationDiscoveryResponseSchema.parse(
      await api.get(`/api/collaboration/shared?limit=100${suffix}`),
    );
    const match = page.items.find((item) => item.status === "accepted"
      && item.resource !== undefined && "chat" in item.resource && item.resource.chat.id === chatId);
    if (match?.status === "accepted") return match.scopeId;
    if (!page.nextCursor) return null;
    if (seenCursors[page.nextCursor]) throw new Error("CollaborationDiscoveryCursorLoop");
    seenCursors[page.nextCursor] = true;
    cursor = page.nextCursor;
  }
  throw new Error("CollaborationDiscoveryPageLimit");
}

function SharedChatHistory({ state, loadMoreMessages }: {
  state: SharedChatState;
  loadMoreMessages: () => Promise<void>;
}) {
  const timeline = projectSharedChatTimeline(state.messages);
  return <section aria-label="Chat history" className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
    {timeline.length === 0 ? <div className="py-12 text-center">
      <div aria-hidden className="text-3xl">◇</div><h2 className="mt-3 font-medium">Start a conversation</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Everyone here collaborates with the same Matrix AI session.</p>
    </div> : timeline.map((message) => <NativeSharedMessageView key={message.id} message={message} />)}
    {state.historyPageError ? <p role="alert" className="text-center text-sm">More messages could not be loaded. Try again.</p> : null}
    {state.hasMoreMessages ? <div className="text-center"><button type="button" className={buttonClass}
      disabled={state.loadingMoreMessages} onClick={() => void loadMoreMessages()}>
      {state.loadingMoreMessages ? "Loading…" : "Load more messages"}
    </button></div> : null}
  </section>;
}

function NativeSharedMessageView({ message }: { message: ReturnType<typeof projectSharedChatTimeline>[number] }) {
  if (message.side === "human") return <article className="ml-auto max-w-[82%] text-right">
    <p className="mb-1 flex items-center justify-end gap-1.5 px-1 text-[11px] text-muted-foreground">
      <span>{message.attribution?.displayName ?? "Unknown participant"}</span>
      <span aria-hidden className="grid size-5 place-items-center rounded-full bg-[var(--bg-hover)] text-[9px] font-semibold">
        {(message.attribution?.displayName ?? "?").slice(0, 1).toUpperCase()}
      </span>
    </p>
    <div className="inline-block rounded-2xl bg-[var(--bg-hover)] px-4 py-2 text-left text-sm">
      {keyedCanonicalParts(message.id, message.parts).map(({ key, part }) => <CanonicalPartView key={key} part={part} human />)}
    </div>
  </article>;
  return <article className="mr-auto max-w-[88%]">
    <div className="space-y-2 break-words">
      {keyedCanonicalParts(message.id, message.parts).map(({ key, part }) => <CanonicalPartView key={key} part={part} />)}
    </div>
  </article>;
}

function CanonicalPartView({ part, human = false }: { part: CanonicalChatMessagePart; human?: boolean }) {
  if (part.type === "text" || part.type === "summary") {
    return human ? <p className="whitespace-pre-wrap">{part.text}</p>
      : <div className="max-w-none text-sm leading-6"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-xl font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
        }}>{part.text}</ReactMarkdown></div>;
  }
  if (part.type === "tool_request") return <MessageDetail label={part.label} detail={part.inputPreview} />;
  if (part.type === "tool_result") return <MessageDetail label={`Tool ${part.outcome}`} detail={part.text} />;
  if (part.type === "attachment_reference") return <MessageDetail label={part.label} detail={part.kind} />;
  if (part.type === "approval_request") return <MessageDetail label={part.title} detail={`${part.description} · ${part.risk} risk`} />;
  if (part.type === "approval_result") return <MessageDetail label="Approval updated" detail={part.decision.replaceAll("_", " ")} />;
  if (part.type === "status") return <MessageDetail label={part.label} detail={part.detail} tone={part.tone} />;
  if (part.type === "invocation_reference") return <MessageDetail label={part.invocation.invocation} detail={part.invocation.arguments} />;
  return <MessageDetail label={part.resource.label} detail={part.resource.path ?? part.resource.kind} />;
}

function keyedCanonicalParts(messageId: string, parts: CanonicalChatMessagePart[]) {
  const occurrences = new Map<string, number>();
  return parts.map((part) => {
    const valueKey = JSON.stringify(part);
    const occurrence = occurrences.get(valueKey) ?? 0;
    occurrences.set(valueKey, occurrence + 1);
    return { key: `${messageId}:${valueKey}:${occurrence}`, part };
  });
}

function MessageDetail({ label, detail, tone }: { label: string; detail?: string; tone?: string }) {
  return <div className="rounded-xl border px-3 py-2 text-sm" data-tone={tone}>
    <p className="font-medium">{label}</p>
    {detail ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{detail}</p> : null}
  </div>;
}

function markRead(api: CollaborationApi, base: string, messages: readonly SharedMessage[]): void {
  const sequence = messages.at(-1)?.sequence;
  if (!sequence || !api.patch) return;
  void api.patch(`${base}/user-state`, { readThroughSeq: sequence }).catch((failure: unknown) => {
    console.warn("[chat-collaboration] read state update failed", failure instanceof Error ? failure.name : "UnknownError");
  });
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

function kindLabel(kind: "chat" | "terminal" | "project" | "file" | "folder" | "app"): string {
  return { chat: "Chat", terminal: "terminal", project: "project", file: "file", folder: "folder", app: "app" }[kind];
}

const buttonClass = "rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";
