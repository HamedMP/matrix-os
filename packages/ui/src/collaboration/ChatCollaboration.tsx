import {
  CollaborationChatMessagesResponseSchema,
  CollaborationChatSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationDiscoveryItemSchema,
  CollaborationInvitationSchema,
  CollaborationScopeSchema,
  CollaborationSharedChatMessageSchema,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod/v4";
import { ChatAttachments, type ChatMessageAttachment } from "../chat/ChatAttachments.js";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";
import { collaborationDraftKey, createCollaborationDraftStore, type CollaborationDraft } from "./chat-state.js";
import { deriveChatPermissions } from "./permissions.js";

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryItemSchema>;
type SharedMessage = z.infer<typeof CollaborationSharedChatMessageSchema>;

export type ChatCollaborationView =
  | { kind: "home" }
  | { kind: "invitation"; invitationId: string }
  | { kind: "chat"; scopeId: string };

export function ChatCollaboration({
  view,
  api,
  actorId,
  runtimeId,
  storage,
  openInvitation = () => undefined,
  openChat = () => undefined,
}: {
  view: ChatCollaborationView;
  api: CollaborationApi;
  actorId: string;
  runtimeId?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  openInvitation?: (invitationId: string) => void;
  openChat?: (scopeId: string) => void;
}) {
  if (view.kind === "home") {
    return <CollaborationHome api={api} openInvitation={openInvitation} openChat={openChat} />;
  }
  if (view.kind === "invitation") {
    return <InvitationView api={api} invitationId={view.invitationId} openChat={openChat} />;
  }
  return <SharedChatView api={api} actorId={actorId} runtimeId={runtimeId ?? "platform"}
    scopeId={view.scopeId} storage={storage} />;
}

function CollaborationHome({ api, openInvitation, openChat }: {
  api: CollaborationApi;
  openInvitation: (invitationId: string) => void;
  openChat: (scopeId: string) => void;
}) {
  const [items, setItems] = useState<DiscoveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([api.get("/api/collaboration/inbox"), api.get("/api/collaboration/shared")])
      .then(([inbox, shared]) => {
        if (!active) return;
        setItems([
          ...CollaborationDiscoveryResponseSchema.parse(inbox).items,
          ...CollaborationDiscoveryResponseSchema.parse(shared).items,
        ]);
        setError(false);
      })
      .catch((failure: unknown) => {
        console.warn("[chat-collaboration] discovery failed", failure instanceof Error ? failure.name : "UnknownError");
        if (active) setError(true);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);

  return <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-5 p-5 sm:p-8">
    <header>
      <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>Collaboration</p>
      <h1 className="mt-1 text-2xl font-semibold">Shared with me</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Invitations and ongoing Chats shared with your Matrix account.</p>
    </header>
    {loading ? <p role="status" className="rounded-2xl border p-6 text-sm">Loading shared Chats…</p> : null}
    {error ? <div role="alert" className="rounded-2xl border p-6">
      <p className="font-medium">Shared Chats are unavailable</p>
      <p className="mt-1 text-sm">Refresh the page to try again.</p>
    </div> : null}
    {!loading && !error && items.length === 0 ? <div className="rounded-2xl border p-10 text-center">
      <div aria-hidden className="text-3xl">◇</div>
      <h2 className="mt-3 text-lg font-medium">Nothing shared yet</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Invitations and accepted shared Chats will appear here.</p>
    </div> : null}
    <div className="grid gap-3">
      {items.map((item) => item.status === "invited"
        ? <article key={`invite:${item.invitationId}`} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{item.resource.owner.displayName} invited you</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Shared Chat · {roleLabel(item.resource.role)}</p>
          </div>
          <button type="button" className={buttonClass} onClick={() => openInvitation(item.invitationId)}>Review invitation</button>
        </article>
        : <article key={`scope:${item.scopeId}`} className="flex flex-wrap items-center gap-4 rounded-2xl border p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{item.resource.chat.title}</p>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Shared Chat · {roleLabel(item.resource.scope.role)}</p>
          </div>
          <button type="button" className={buttonClass} onClick={() => openChat(item.scopeId)}>Open Chat</button>
        </article>)}
    </div>
  </main>;
}

function InvitationView({ api, invitationId, openChat }: {
  api: CollaborationApi;
  invitationId: string;
  openChat: (scopeId: string) => void;
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
      const result = z.object({ scopeId: z.uuid() }).loose().parse(await api.post(
        `/api/collaboration/invitations/${encodeURIComponent(invitation.id)}/accept`,
        { clientRequestId: crypto.randomUUID(), expectedRevision: invitation.revision },
      ));
      openChat(result.scopeId);
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] invitation acceptance failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally { setPending(false); }
  };
  if (error && !invitation) return <SafeError title="Invitation unavailable" />;
  if (!invitation) return <p role="status" className="p-8">Loading invitation…</p>;
  return <main className="mx-auto flex min-h-full w-full max-w-2xl items-center p-5 sm:p-8">
    <section className="w-full rounded-2xl border p-6 sm:p-8">
      <p className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: "var(--text-tertiary)" }}>Chat invitation</p>
      <h1 className="mt-2 text-2xl font-semibold">Join this shared Chat?</h1>
      <p className="mt-3">{invitation.owner.displayName} invited you as an {invitation.role}.</p>
      <div className="mt-5 rounded-xl border p-4 text-sm">
        <p className="font-medium">What you’ll get</p>
        <p className="mt-1" style={{ color: "var(--text-secondary)" }}>Access to this ongoing Chat’s history and human discussion.</p>
        <p className="mt-3 font-medium">What stays private</p>
        <p className="mt-1" style={{ color: "var(--text-secondary)" }}>This does not include its project, sibling Chats, files, apps, terminals, or anyone’s private drafts.</p>
      </div>
      <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>AI requests are unavailable in shared Chats during this milestone.</p>
      {error ? <p role="alert" className="mt-4 text-sm">Invitation could not be accepted. Refresh and try again.</p> : null}
      <button type="button" className={`${buttonClass} mt-6 w-full`} disabled={pending || invitation.status !== "pending"} onClick={() => void accept()}>
        {pending ? "Accepting…" : invitation.status === "pending" ? "Accept invitation" : "Invitation unavailable"}
      </button>
    </section>
  </main>;
}

function SharedChatView({ api, actorId, runtimeId, scopeId, storage }: {
  api: CollaborationApi;
  actorId: string;
  runtimeId: string;
  scopeId: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}) {
  const [scope, setScope] = useState<z.infer<typeof CollaborationScopeSchema> | null>(null);
  const [chat, setChat] = useState<z.infer<typeof CollaborationChatSchema> | null>(null);
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [draft, setDraft] = useState<CollaborationDraft>({ text: "", mode: "discussion" });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"load" | "send" | "unavailable" | null>(null);
  const loadGeneration = useRef(0);
  const draftStore = useMemo(() => createCollaborationDraftStore(storage ?? browserStorage()), [storage]);
  const draftKey = useMemo(() => collaborationDraftKey({
    actorId, runtimeId, scopeId, chatId: scope?.resourceId ?? "pending_chat",
  }), [actorId, runtimeId, scope?.resourceId, scopeId]);
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
      setScope(nextScope); setChat(nextChat); setMessages(nextMessages);
      setLoadingMoreMessages(false);
      setError((current) => clearForegroundError || current === "load" || current === "unavailable" ? null : current);
      setHasMoreMessages(BigInt(nextChat.messageCount) > BigInt(nextMessages.length));
      if (api.patch && nextMessages.length > 0) {
        const sequence = nextMessages.at(-1)!.sequence;
        void api.patch(`${base}/user-state`, { readThroughSeq: sequence }).catch((failure: unknown) => {
          console.warn("[chat-collaboration] read state update failed", failure instanceof Error ? failure.name : "UnknownError");
        });
      }
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] Chat load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === loadGeneration.current) setError("load");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [api, scopeId]);
  useEffect(() => {
    setScope(null); setChat(null); setMessages([]); setDraft({ text: "", mode: "discussion" });
    setLoading(true); setLoadingMoreMessages(false); setError(null);
    void load(true);
    return () => { loadGeneration.current += 1; };
  }, [load]);
  const loadMoreMessages = async () => {
    const after = messages.at(-1)?.sequence;
    if (!after || !chat || loadingMoreMessages) return;
    const generation = loadGeneration.current;
    setLoadingMoreMessages(true);
    try {
      const next = CollaborationChatMessagesResponseSchema.parse(await api.get(
        `/api/collaboration/scopes/${encodeURIComponent(scopeId)}/chat/messages?after=${encodeURIComponent(after)}&limit=100`,
      )).messages;
      if (generation !== loadGeneration.current) return;
      const appended = next.filter((message) => !messages.some((known) => known.id === message.id));
      const combined = [...messages, ...appended];
      setMessages(combined);
      setHasMoreMessages(appended.length > 0 && BigInt(chat.messageCount) > BigInt(combined.length));
      const sequence = combined.at(-1)?.sequence;
      if (sequence && api.patch) {
        void api.patch(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}/user-state`, {
          readThroughSeq: sequence,
        }).catch((failure: unknown) => {
          console.warn("[chat-collaboration] read state update failed", failure instanceof Error ? failure.name : "UnknownError");
        });
      }
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] history page failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === loadGeneration.current) setError("load");
    } finally {
      if (generation === loadGeneration.current) setLoadingMoreMessages(false);
    }
  };
  useEffect(() => {
    if (!scope) return;
    const key = collaborationDraftKey({ actorId, runtimeId, scopeId, chatId: scope.resourceId });
    setDraft(draftStore.load(key));
  }, [actorId, draftStore, runtimeId, scope, scopeId]);
  useEffect(() => api.subscribe?.(scopeId, () => { void load(false); }, () => setError("unavailable")), [api, load, scopeId]);
  const updateDraft = (text: string) => {
    const next = { text, mode: "discussion" as const };
    setDraft(next);
    if (scope) draftStore.save(draftKey, next);
  };
  const send = async () => {
    if (!scope || !draft.text.trim() || !deriveChatPermissions(scope).canDiscuss) return;
    setSending(true); setError(null);
    try {
      await api.post(`/api/collaboration/scopes/${encodeURIComponent(scopeId)}/chat/messages`, {
        clientRequestId: crypto.randomUUID(), expectedRevision: scope.revision, text: draft.text.trim(),
      });
      draftStore.clear(draftKey);
      setDraft({ text: "", mode: "discussion" });
      await load(false);
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] discussion send failed", failure instanceof Error ? failure.name : "UnknownError");
      setError("send");
    } finally { setSending(false); }
  };
  if (loading) return <p role="status" className="p-8">Loading shared Chat…</p>;
  if (!scope || !chat || error === "load" || error === "unavailable") return <SafeError title="Shared Chat unavailable" />;
  const permissions = deriveChatPermissions(scope);
  return <main className="mx-auto flex h-full min-h-[32rem] w-full max-w-4xl flex-col">
    <header className="border-b p-4 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="truncate text-lg font-semibold">{chat.title}</h1>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>Shared Chat · {permissions.roleLabel}</p></div>
        <span className="rounded-full border px-2.5 py-1 text-xs">Discussion only</span>
      </div>
    </header>
    <section aria-label="Chat history" className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
      {messages.length === 0 ? <div className="py-12 text-center">
        <div aria-hidden className="text-3xl">◇</div><h2 className="mt-3 font-medium">Start the discussion</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>Messages here are visible to everyone in this shared Chat.</p>
      </div> : messages.map((message) => <SharedMessageView key={message.id} message={message} />)}
      {hasMoreMessages ? <div className="text-center"><button type="button" className={buttonClass}
        disabled={loadingMoreMessages} onClick={() => void loadMoreMessages()}>
        {loadingMoreMessages ? "Loading…" : "Load more messages"}
      </button></div> : null}
    </section>
    <footer className="border-t p-4 sm:px-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
        <span>{permissions.composerExplanation}</span><span>{permissions.aiExplanation}</span>
      </div>
      {error === "send" ? <p role="alert" className="mb-2 text-sm">Message was not sent. Your draft is still here—try again.</p> : null}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1"><span className="sr-only">Message everyone</span>
          <textarea aria-label="Message everyone" rows={3} value={draft.text} disabled={!permissions.canDiscuss || sending}
            placeholder={permissions.canDiscuss ? "Message everyone…" : "Read-only access"}
            onChange={(event) => updateDraft(event.target.value)} className="block w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60" />
        </label>
        <button type="button" className={buttonClass} disabled={!permissions.canDiscuss || sending || !draft.text.trim()} onClick={() => void send()}>
          {sending ? "Sending…" : "Send message"}
        </button>
      </div>
    </footer>
  </main>;
}

function SharedMessageView({ message }: { message: SharedMessage }) {
  const attachments: ChatMessageAttachment[] = message.parts.flatMap((part) => part.type === "attachment_reference"
    ? [{ id: part.attachmentId, label: part.label, kind: part.kind === "image" ? "image" as const : "file" as const }]
    : []);
  const texts = message.parts.flatMap((part, partIndex) => part.type === "text" || part.type === "summary"
    ? [{ key: `${message.id}:text:${partIndex}`, text: part.text }]
    : []);
  const notices = message.parts.flatMap((part, partIndex) => part.type === "status"
    ? [{ key: `${message.id}:status:${partIndex}`, text: part.detail ?? part.label }]
    : part.type === "tool_request"
      ? [{ key: `${message.id}:tool-request:${partIndex}`, text: `Tool request: ${part.label}` }]
      : part.type === "tool_result"
        ? [{ key: `${message.id}:tool-result:${partIndex}`, text: part.text ?? `Tool ${part.outcome}` }]
        : []);
  return <article className="rounded-2xl border p-4">
    <header className="mb-2 flex items-center justify-between gap-3">
      <span className="font-medium">{message.actor.displayName}</span>
      <time className="text-xs" style={{ color: "var(--text-tertiary)" }} dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
    </header>
    <div className="prose prose-sm max-w-none break-words">
      {texts.map((entry) => <ReactMarkdown key={entry.key} remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl}>{entry.text}</ReactMarkdown>)}
      {notices.map((entry) => <p key={entry.key} className="text-sm" style={{ color: "var(--text-secondary)" }}>{entry.text}</p>)}
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

const collaborationDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTime(value: string): string {
  return collaborationDateTimeFormat.format(new Date(value));
}

const buttonClass = "rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";
