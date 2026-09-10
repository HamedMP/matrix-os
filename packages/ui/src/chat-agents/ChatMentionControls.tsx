import { useCallback, useEffect, useState } from "react";
import type { CanonicalChatResourceReference, ChatContextSnapshot } from "@matrix-os/contracts";
import { Dialog } from "../Dialog.js";
import type { ChatAgentClient } from "./client.js";
import { chatAgentButtonClass, chatAgentMutedStyle, chatAgentSurfaceStyle } from "./theme.js";

export function useChatMentionPermission(scope: string, resources: CanonicalChatResourceReference[], permissionMode: string) {
  const agentId = resources.find((resource) => resource.kind === "agent")?.id;
  const key = `${scope}\0${agentId ?? ""}`;
  const [confirmation, setConfirmation] = useState<{ key: string; allowed: boolean } | null>(null);
  // Forget consent immediately when the selected Agent or Chat changes.
  if (confirmation && confirmation.key !== key) setConfirmation(null);
  const confirmed = confirmation?.key === key && confirmation.allowed;
  return {
    allowed: !agentId || permissionMode === "full_access" || confirmed,
    confirmed,
    permissionMode: agentId && (permissionMode === "full_access" || confirmed) ? "full_access" : permissionMode,
    confirm: useCallback((allowed: boolean) => setConfirmation({ key, allowed }), [key]),
  };
}

function ContextPreview({ client, reference, onClose }: {
  client: ChatAgentClient; reference: CanonicalChatResourceReference; onClose(): void;
}) {
  const [state, setState] = useState<{ snapshot?: ChatContextSnapshot; error?: string }>({});
  useEffect(() => {
    let current = true;
    void client.preview(reference.id).then((snapshot) => {
      if (current) setState({ snapshot });
    }).catch((failure: unknown) => {
      console.warn("[chat-mentions] Preview unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setState({ error: "This Chat context is unavailable. Remove the reference or try again." });
    });
    return () => { current = false; };
  }, [client, reference.id]);
  return <Dialog open onClose={onClose} aria-label={`Context from ${reference.label}`} style={{ ...chatAgentSurfaceStyle, maxWidth: "600px", width: "min(92vw, 600px)" }}>
    <div className="flex items-center justify-between gap-3"><h2 className="min-w-0 truncate text-base font-semibold">{state.snapshot?.title ?? reference.label}</h2>
      <button type="button" className={chatAgentButtonClass} onClick={onClose}>Close preview</button></div>
    <p className="mt-3 text-xs" style={chatAgentMutedStyle}>A fresh snapshot is captured when you send. Tools, attachments, and other Chat references are excluded.</p>
    {state.error ? <p role="alert" className="mt-4 text-sm">{state.error}</p> : state.snapshot ? <>
      <p className="mt-4 text-xs">{state.snapshot.truncated ? "Limited recent context" : "Chat context"} · through message {state.snapshot.throughSeq}</p>
      <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-sans text-sm">{state.snapshot.text || "No committed text in this Chat."}</pre>
    </> : <p role="status" className="mt-4 text-sm">Loading context…</p>}
  </Dialog>;
}

export function ChatMentionControls({ client, resources, permissionMode, confirmed, onConfirm }: {
  client?: ChatAgentClient; resources: CanonicalChatResourceReference[]; permissionMode: string;
  confirmed: boolean; onConfirm(value: boolean): void;
}) {
  const agent = resources.find((resource) => resource.kind === "agent");
  const chats = resources.filter((resource) => resource.kind === "chat");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = chats.find((chat) => chat.id === previewId);
  if (!agent && !chats.length) return null;
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 px-3 py-2 text-xs" style={chatAgentMutedStyle}>
    {agent ? <div className="grid min-w-0 gap-2">
      <span className="flex min-w-0 items-center gap-1"><strong className="min-w-0 truncate" title={agent.label}>{agent.label}</strong><span className="shrink-0">· Hermes · this request only</span></span>
      {permissionMode === "full_access" ? <span>Full access on this computer.</span> : <label className="flex items-start gap-2">
        <input type="checkbox" checked={confirmed} onChange={(event) => onConfirm(event.target.checked)} />
        Allow Full access on this computer for this Agent request.
      </label>}
    </div> : null}
    {chats.length ? <div className="flex flex-wrap items-center gap-2"><span>Chat context:</span>{chats.map((chat) => (
      <button key={chat.id} type="button" className="max-w-52 truncate rounded-md border px-2 py-1.5 underline-offset-2 hover:underline" aria-label={`Preview ${chat.label}`} title={chat.label} disabled={!client} onClick={() => setPreviewId(chat.id)}>{chat.label}</button>
    ))}</div> : null}
    {client && preview ? <ContextPreview key={preview.id} client={client} reference={preview} onClose={() => setPreviewId(null)} /> : null}
  </div>;
}
