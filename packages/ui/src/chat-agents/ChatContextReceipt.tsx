import type { ChatRunContext } from "@matrix-os/contracts";

/** Historical evidence reads the admitted snapshot and never refetches the source Chat. */
export function ChatContextReceipt({ context }: { context?: ChatRunContext }) {
  if (!context?.agent && !context?.chats.length) return null;
  return <div className="my-2 grid min-w-0 max-w-full gap-2 text-xs" style={{ color: "var(--text-secondary, var(--matrix-muted-fg))" }}>
    {context.agent ? <p className="truncate font-medium" title={context.agent.name}>{context.agent.name} · Hermes</p> : null}
    {context.chats.length ? <details className="min-w-0 rounded-lg border px-3 py-2">
      <summary className="cursor-pointer">Context used · {context.chats.length} {context.chats.length === 1 ? "Chat" : "Chats"}</summary>
      {context.chats.map((chat) => <div className="mt-3" key={chat.chatId}>
        <p className="truncate font-medium" title={chat.title}>{chat.title}</p>
        <p className="mt-1">{chat.truncated ? "Limited recent context" : "Snapshot"} · through message {chat.throughSeq}</p>
        <pre className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-sans">{chat.text || "No committed text."}</pre>
      </div>)}
    </details> : null}
  </div>;
}
