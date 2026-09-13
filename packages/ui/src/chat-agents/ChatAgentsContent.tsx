import { useEffect, useRef, type ReactNode } from "react";
import { ChatAgentsPanel } from "./ChatAgentsEntry.js";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";
import type { ChatAgentClient } from "./client.js";

export function ChatAgentsContent({ client, scopeKey, children }: {
  client?: ChatAgentClient; scopeKey: string; children: ReactNode;
}) {
  const navigation = useChatAgentsNavigation();
  const previousScope = useRef({ scopeKey, client });
  const scopeChanged = previousScope.current.scopeKey !== scopeKey || previousScope.current.client !== client;
  const opened = !scopeChanged && navigation?.opened?.client === client ? navigation?.opened : null;
  const close = navigation?.close;
  useEffect(() => {
    if (previousScope.current.scopeKey !== scopeKey || previousScope.current.client !== client) {
      previousScope.current = { scopeKey, client };
      close?.();
    }
  }, [scopeKey, client, close]);
  return <>
    <div hidden={Boolean(opened)} inert={Boolean(opened)} style={{ display: opened ? "none" : "flex" }}
      className="min-h-0 min-w-0 flex-1">
      {children}
    </div>
    {opened ? <ChatAgentsPanel client={opened.client} onSetup={opened.onSetup} onClose={() => close?.(true)} /> : null}
  </>;
}
