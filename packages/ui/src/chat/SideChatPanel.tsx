import { useEffect, useRef, useState } from "react";
import type { CanonicalSideChatSnapshot, CanonicalSideChatTurnRequest } from "@matrix-os/contracts";

export interface SideChatClient {
  getSideChat(chatId: string): Promise<CanonicalSideChatSnapshot>;
  createSideChat(chatId: string): Promise<CanonicalSideChatSnapshot>;
  askSideChat(chatId: string, input: CanonicalSideChatTurnRequest): Promise<CanonicalSideChatSnapshot>;
}

/** Server-owned child chat with no execution tools. A copied answer is still a draft. */
export function SideChatPanel({ chatId, client, onSendToMain }: {
  chatId: string;
  client: SideChatClient;
  onSendToMain(text: string): void;
}) {
  const [snapshot, setSnapshot] = useState<CanonicalSideChatSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null);
    setLoading(true);
    setError(null);
    void client.getSideChat(chatId).then(value => {
      if (generation.current === current) setSnapshot(value);
    }).catch((cause: unknown) => {
      if (generation.current !== current) return;
      console.warn("[side-chat] Read failed:", cause instanceof Error ? cause.name : "UnknownError");
      setError("Side chat could not be loaded. Try again.");
    }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current++; };
  }, [chatId, client]);
  const send = async () => {
    const text = draft.trim();
    if (!text || pending || !snapshot) return;
    const current = generation.current;
    setPending(true);
    setError(null);
    try {
      if (!snapshot.threadId) await client.createSideChat(chatId);
      const response = await client.askSideChat(chatId, { clientRequestId: `req_${crypto.randomUUID().replaceAll("-", "")}`, text });
      if (generation.current !== current) return;
      setSnapshot(response);
      setDraft("");
    } catch (cause: unknown) {
      if (generation.current !== current) return;
      console.warn("[side-chat] Turn failed:", cause instanceof Error ? cause.name : "UnknownError");
      setError("Side chat could not answer. Try again.");
    } finally {
      if (generation.current === current) setPending(false);
    }
  };
  return <section aria-label="Side chat" className="flex min-h-0 flex-1 flex-col" style={{ color: "var(--text-primary, var(--foreground))" }}>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {loading ? <p role="status" className="text-sm">Loading side chat…</p> : null}
      {!loading && snapshot?.messages.length === 0 ? <p className="text-sm opacity-70">Ask about this chat. Side chat can read its committed messages but cannot change files or send to main.</p> : null}
      {snapshot?.messages.map(message => <article key={message.seq} className="mb-3 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border-default, var(--border))" }}>
        <span className="mb-1 block text-xs opacity-60">{message.role === "user" ? "You" : "Side chat"}</span>
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
        {message.role === "assistant" ? <button type="button" className="mt-2 text-xs font-semibold underline" onClick={() => onSendToMain(message.content)}>Send to main chat</button> : null}
      </article>)}
    </div>
    {error ? <p role="alert" className="px-3 py-1 text-xs" style={{ color: "var(--danger, var(--destructive))" }}>{error}</p> : null}
    <form className="flex shrink-0 gap-2 border-t p-3" style={{ borderColor: "var(--border-default, var(--border))" }} onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="Ask side chat" value={draft} onChange={event => setDraft(event.target.value)} maxLength={8_000} rows={2}
        className="min-w-0 flex-1 resize-none rounded-lg border bg-transparent p-2 text-sm outline-none" style={{ borderColor: "var(--border-default, var(--border))" }}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}/>
      <button type="submit" aria-label="Send side question" disabled={pending || loading || !draft.trim()} className="self-end rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50" style={{ borderColor: "var(--border-default, var(--border))" }}>Send</button>
    </form>
  </section>;
}
