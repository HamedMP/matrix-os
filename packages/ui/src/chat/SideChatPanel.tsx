import { useEffect, useRef, useState } from "react";
import type { CanonicalSideChatSnapshot, CanonicalSideChatTurnRequest } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import { ArrowLeftToLine, ArrowUp, Check, Copy, Info } from "lucide-react";
import { Tooltip } from "../Tooltip.js";
import "./desktop-chat.css";

export interface SideChatClient {
  getSideChat(chatId: string): Promise<CanonicalSideChatSnapshot>;
  createSideChat(chatId: string): Promise<CanonicalSideChatSnapshot>;
  askSideChat(chatId: string, input: CanonicalSideChatTurnRequest): Promise<CanonicalSideChatSnapshot>;
}

/** Server-owned child chat with no execution tools. A copied answer is still a draft. */
export function SideChatPanel({ chatId, chatTitle = "the main chat", client, onSendToMain }: {
  chatId: string;
  chatTitle?: string;
  client: SideChatClient;
  onSendToMain(text: string): void;
}) {
  const [snapshot, setSnapshot] = useState<CanonicalSideChatSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null);
    setLoading(true);
    setError(null);
    setCopied(null);
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
  const copyAnswer = async (seq: number, text: string) => {
    const current = generation.current;
    try {
      await navigator.clipboard.writeText(text);
      if (generation.current === current) setCopied(seq);
    } catch (cause: unknown) {
      console.warn("[side-chat] Copy failed:", cause instanceof Error ? cause.name : "UnknownError");
      if (generation.current === current) setError("The answer could not be copied. Try again.");
    }
  };
  return <section aria-label="Side chat" className="desktop-chat-design side-chat-panel">
    <div className="side-chat-transcript">
      <div role="note" className="side-chat-note"><Info size={14} aria-hidden/><p>Side chat can read {chatTitle}. Nothing here changes it.</p></div>
      {loading ? <p role="status" className="text-sm">Loading side chat…</p> : null}
      {!loading && snapshot?.messages.length === 0 ? <p className="text-sm opacity-70">Ask about this chat. Side chat can read its committed messages but cannot change files or send to main.</p> : null}
      {snapshot?.messages.map(message => <article key={message.seq} aria-label={message.role === "user" ? "You" : "Side chat answer"} className={message.role === "user" ? "side-chat-user" : "side-chat-answer"}>
        <p>{message.content}</p>
        {message.role === "assistant" ? <div className="side-chat-actions">
          <Tooltip content="Send to main chat"><Button variant="ghost" size="icon" aria-label="Send to main chat" className="desktop-chat-icon" onClick={() => onSendToMain(message.content)}><ArrowLeftToLine size={14} aria-hidden/></Button></Tooltip>
          <Tooltip content={copied === message.seq ? "Copied" : "Copy"}><Button variant="ghost" size="icon" aria-label="Copy answer" className="desktop-chat-icon" onClick={() => { void copyAnswer(message.seq, message.content); }}>{copied === message.seq ? <Check size={14} aria-hidden/> : <Copy size={14} aria-hidden/>}</Button></Tooltip>
        </div> : null}
      </article>)}
    </div>
    {error ? <p role="alert" className="px-3 py-1 text-xs" style={{ color: "var(--danger, var(--destructive))" }}>{error}</p> : null}
    <form className="side-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="Ask side chat" placeholder="Ask on the side…" value={draft} onChange={event => setDraft(event.target.value)} maxLength={8_000} rows={1}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}/>
      <Button type="submit" size="sm" aria-label="Send side question" disabled={pending || loading || !draft.trim()} className="side-chat-send"><ArrowUp size={16} aria-hidden/></Button>
    </form>
  </section>;
}
