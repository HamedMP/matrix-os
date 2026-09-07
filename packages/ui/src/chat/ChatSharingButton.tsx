import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";


import { ChatShareDialog } from "./ChatShareDialog.js";

const PreviewSchema = z.object({
  title: z.string().max(240), revision: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(96_000) })).max(200),
});
const SharesSchema = z.object({ shares: z.array(z.object({ id: z.uuid(), expiresAt: z.string().max(100) })).max(10) });
const CreatedSchema = z.object({ id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });

export function ChatSharingButton({ api, chatId, copyText, handle, runtimeSlot, platformHost }: {
  api: { baseUrl: string; get(path: string): Promise<unknown>; post(path: string, body: unknown): Promise<unknown>; delete(path: string): Promise<unknown> };
  handle: string | null;
  runtimeSlot: string;
  platformHost: string;
  chatId: string;
  copyText: (value: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<z.infer<typeof PreviewSchema> | null>(null);
  const [existing, setExisting] = useState<z.infer<typeof SharesSchema>["shares"]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const path = `/api/chats/${encodeURIComponent(chatId)}/shares`;
  const open = async () => {
    setPending(true); setError(false);
    try {
      const [snapshot, links] = await Promise.all([api.get(`${path}/preview`), api.get(path)]);
      if (!alive.current) return;
      setPreview(PreviewSchema.parse(snapshot));
      setExisting(SharesSchema.parse(links).shares);
    } catch (failure: unknown) {
      console.warn("[chat-share] preview failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally { if (alive.current) setPending(false); }
  };
  return <div className="relative inline-flex shrink-0 items-center gap-2 text-xs">
    {error ? <span role="alert" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border bg-[var(--bg-surface,var(--background))] p-3 shadow-lg">Sharing unavailable. Try again.</span> : null}
    <button type="button" disabled={pending} onClick={() => void open()} className="rounded-lg px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-50">{pending ? "Loading share…" : "Share"}</button>
    {preview ? <ChatShareDialog title={preview.title} messages={preview.messages} existing={existing} copyText={copyText}
      onClose={() => setPreview(null)} revoke={async (id) => { await api.delete(`${path}/${encodeURIComponent(id)}`); }}
      createLink={async () => {
        const created = CreatedSchema.parse(await api.post(path, { revision: preview.revision, fingerprint: preview.fingerprint, confirmed: true }));
        const url = handle && platformHost
          ? new URL(`/shared/chat/${encodeURIComponent(handle)}/${encodeURIComponent(runtimeSlot)}/${created.token}`, platformHost).href
          : new URL(`/api/share/chats/${created.token}`, api.baseUrl).href;
        return { id: created.id, url };
      }} /> : null}
  </div>;
}
