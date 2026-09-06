import { Dialog } from "../Dialog.js";
import { useState } from "react";

export function ChatShareDialog({ title, messages, createLink, copyText, revoke, onClose, existing = [] }: {
  title: string;
  messages: Array<{ role: string; text: string }>;
  createLink: () => Promise<{ id: string; url: string }>;
  copyText: (value: string) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  onClose: () => void;
  existing?: Array<{ id: string; expiresAt: string }>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [revokedIds, setRevokedIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const action = async (run: () => Promise<void>) => {
    setPending(true);
    setError("");
    try { await run(); }
    catch (failure: unknown) {
      console.warn("[chat-share] action failed", failure instanceof Error ? failure.name : "UnknownError");
      setError("Sharing unavailable. Refresh the Chat and try again.");
    } finally { setPending(false); }
  };
  const remove = (id: string) => action(async () => {
    await revoke(id);
    setRevokedIds((current) => [...current, id]);
    if (link?.id === id) setLink(null);
    setFeedback("Link revoked.");
  });
  const buttonClass = "rounded-lg border px-3 py-2 text-sm disabled:opacity-50 hover:enabled:bg-[var(--bg-hover)]";
  return <Dialog open onClose={() => { if (!pending) onClose(); }} aria-label="Share Chat" className="ph-no-capture flex max-h-[85vh] w-[min(92vw,600px)] flex-col gap-4 overflow-y-auto rounded-2xl border p-6" style={{ background: "var(--bg-surface, var(--matrix-card))", color: "var(--text-primary, var(--matrix-card-fg))", borderColor: "var(--border-default)" }}>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Share Chat</h2>
          <button type="button" onClick={onClose} disabled={pending} className={buttonClass} aria-label="Close sharing">Close</button>
        </div>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Anyone with the link can read this snapshot for 7 days. Later messages are not added. Attachments, tool output, and hidden context are excluded. Revoking a link cannot recall copies already saved.
        </p>
        <section aria-label="Share preview" className="max-h-64 shrink-0 overflow-auto rounded-lg border p-3 text-sm">
          <h3 className="font-semibold">{title}</h3>
          {messages.map((message, index) => <div key={index} className="mt-3">
            <strong>{message.role === "user" ? "User" : "Assistant"}</strong>
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
          </div>)}
        </section>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I reviewed the text for sensitive information and want anyone with the link to read it.
        </label>
        {link ? <div className="flex flex-wrap gap-2">
          <input aria-label="Shared Chat link" readOnly value={link.url} className="w-full rounded-lg border bg-transparent p-2 text-sm" onFocus={(event) => event.target.select()} />
          <button className={buttonClass} disabled={pending} onClick={() => void action(async () => {
            try { await copyText(link.url); setFeedback("Link copied."); }
            catch (failure: unknown) {
              console.warn("[chat-share] copy failed", failure instanceof Error ? failure.name : "UnknownError");
              setError("Could not copy. Select and copy the link above.");
            }
          })}>Copy link</button>
          <button className={buttonClass} disabled={pending} onClick={() => void remove(link.id)}>Revoke link</button>
        </div> : <button className={buttonClass} disabled={!confirmed || pending || messages.length === 0} onClick={() => void action(async () => {
          setLink(await createLink()); setFeedback("Link created.");
        })}>{pending ? "Creating…" : "Create link"}</button>}
        {existing.filter((share) => !revokedIds.includes(share.id) && share.id !== link?.id).map((share) => <div key={share.id} className="flex justify-between gap-2 text-xs">
          <span>Link expires {new Date(share.expiresAt).toLocaleDateString()}</span>
          <button className={buttonClass} disabled={pending} onClick={() => void remove(share.id)}>Revoke previous link</button>
        </div>)}
        {error ? <p role="alert" className="text-sm">{error}</p> : <p role="status" className="text-sm">{feedback}</p>}
  </Dialog>;
}
