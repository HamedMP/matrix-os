import { useEffect, useState } from "react";
import { canAddChatMention, orderChatResources, type ChatAgentClient } from "@matrix-os/ui";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";

export function ChatMentionPicker({ client, scope, query, resources, onSelect, onDismiss, listRef }: {
  client?: ChatAgentClient; scope: string; query: string | null;
  listRef: React.RefObject<HTMLDivElement | null>; onDismiss(): void;
  resources: CanonicalChatResourceReference[]; onSelect(resource: CanonicalChatResourceReference): void;
}) {
  const [result, setResult] = useState<{ client: ChatAgentClient; enabled: boolean; key: string; resources: CanonicalChatResourceReference[]; error?: boolean } | null>(null);
  const key = `${scope}\0${query}`;
  useEffect(() => {
    if (!client || query === null) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void client.search(query, scope === "new" ? undefined : scope).then((response) => {
        if (current) setResult({ client, enabled: response.enabled, key, resources: response.enabled ? orderChatResources(response.resources) : [] });
      }).catch((error: unknown) => {
        console.warn("[chat-mentions] Search unavailable:", error instanceof Error ? error.name : "UnknownError");
        if (current) setResult({ client, enabled: true, key, resources: [], error: true });
      });
    }, 120);
    return () => { current = false; window.clearTimeout(timer); };
  }, [client, key, scope, query]);
  if (!client || query === null || result?.client !== client || result.key !== key || !result.enabled) return null;
  const items = result?.key === key ? result.resources : [];
  return <div ref={listRef} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); onDismiss(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)'));
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  }} className="max-h-56 overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-sm" role="listbox" aria-label="Agents and Chat context">
    {items.map((resource, index) => <div key={`${resource.kind}:${resource.id}`}>
      {index === 0 || items[index - 1]?.kind !== resource.kind ? <div className="px-2 py-1 text-xs text-muted-foreground">{resource.kind === "agent" ? "Agents" : "Chats"}</div> : null}
      <button type="button" role="option" aria-selected={false} disabled={!canAddChatMention(resources, resource)}
        className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-40"
        onClick={() => onSelect(resource)}>{resource.label}</button>
    </div>)}
    {!items.length ? <p className="px-2 py-2 text-xs text-muted-foreground">{result?.key !== key ? "Searching…" : result.error ? "References could not be loaded. Try again." : "No matching Agents or Chats."}</p> : null}
  </div>;
}
