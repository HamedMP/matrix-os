import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatAgentClient } from "./client.js";

type OpenAgents = { client: ChatAgentClient; onSetup?: () => void };
type Navigation = {
  opened: OpenAgents | null;
  open(value: OpenAgents, trigger: HTMLButtonElement): void;
  close(restoreFocus?: boolean): void;
};
const Context = createContext<Navigation | null>(null);

function LocalWorkspace({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<OpenAgents | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const open = useCallback((value: OpenAgents, element: HTMLButtonElement) => {
    trigger.current = element;
    setOpened(value);
  }, []);
  const close = useCallback((restoreFocus = false) => {
    setOpened(null);
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus();
  }, []);
  const value = useMemo(() => ({ opened, open, close }), [opened, open, close]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Share navigation across a hosted rail and main pane; standalone Chat owns it locally. */
export function ChatAgentsWorkspace({ children }: { children: ReactNode }) {
  const inherited = useContext(Context);
  return inherited ? children : <LocalWorkspace>{children}</LocalWorkspace>;
}

export function useChatAgentsNavigation() {
  return useContext(Context);
}
