import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChatAgentsPanel } from "./ChatAgentsEntry.js";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";
import type { ChatAgentClient } from "./client.js";

export function ChatAgentsContent({ client, scopeKey, onOpenBotChat, hostedChrome = false, children }: {
  hostedChrome?: boolean; client?: ChatAgentClient; scopeKey: string; onOpenBotChat?: (chatId: string) => void; children: ReactNode;
}) {
  const navigation = useChatAgentsNavigation();
  const [previousScope, setPreviousScope] = useState({ scopeKey, client });
  const scopeChanged = previousScope.scopeKey !== scopeKey || previousScope.client !== client;
  const opened = !scopeChanged && navigation?.opened?.client === client ? navigation?.opened : null;
  const close = navigation?.close;
  const setTitle = navigation?.setTitle, generation = navigation?.generation;
  const onTitleChange = useCallback((title: "Your AI team" | "New agent" | "Edit agent") => {
    if (client && generation !== undefined) setTitle?.(client, generation, title);
  }, [client, generation, setTitle]);
  // Hold the changed route closed until its old Agents surface has been released.
  if (scopeChanged && !navigation?.opened) setPreviousScope({ scopeKey, client });
  useEffect(() => { if (scopeChanged) close?.(); }, [scopeChanged, close]);
  return <>
    <div hidden={Boolean(opened)} inert={Boolean(opened)} style={{ display: opened ? "none" : "flex" }}
      className="min-h-0 min-w-0 flex-1">
      {children}
    </div>
    {opened ? <ChatAgentsPanel client={opened.client} view={opened.view} onStartChat={opened.onStartChat} onSetup={opened.onSetup}
      hostedChrome={hostedChrome} onTitleChange={onTitleChange} onOpenBotChat={onOpenBotChat} onClose={() => close?.(true)} /> : null}
  </>;
}
