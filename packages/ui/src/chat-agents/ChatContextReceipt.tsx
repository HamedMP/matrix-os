import type { ChatRunContext } from "@matrix-os/contracts";

function integrationName(service: string): string {
  return service.split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

/** Historical evidence reads the admitted snapshot and never refetches the source Chat. */
export function ChatContextReceipt({ context }: { context?: ChatRunContext }) {
  if (!context?.agent && !context?.chats.length) return null;
  return <div className="my-2 grid min-w-0 max-w-full gap-2 text-xs" style={{ color: "var(--text-secondary, var(--matrix-muted-fg))" }}>
    {context.agent ? <p className="truncate font-medium" title={context.agent.name}>{context.agent.name} · Hermes</p> : null}
    {context.agent?.recipe ? <details className="min-w-0 rounded-lg border px-3 py-2">
      <summary className="cursor-pointer">Recipe used</summary>
      <div className="mt-3 grid min-w-0 gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="font-medium">Pinned skills</p>
          {context.agent.recipe.skills.map((skill) => <p key={skill.id} className="min-w-0 truncate" title={`${skill.name} · sha256:${skill.sha256}`}>
            {skill.name} · <code>{skill.sha256.slice(0, 12)}</code>
          </p>)}
        </div>
        {context.agent.recipe.integrations.length ? <div className="grid min-w-0 gap-1">
          <p className="font-medium">Selected integrations</p>
          {context.agent.recipe.integrations.map((integration) => <p key={`${integration.service}:${integration.accountLabel ?? ""}`}
            className="min-w-0 truncate" title={`${integrationName(integration.service)} · ${integration.accountLabel ?? "Ask when run"}`}>
            {integrationName(integration.service)} · {integration.accountLabel ?? "Ask when run"}
          </p>)}
        </div> : null}
        <div className="min-w-0"><p className="font-medium">Expected output</p><p className="mt-1 whitespace-pre-wrap break-words">{context.agent.recipe.output}</p></div>
      </div>
    </details> : null}
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
