import type { StartAgentChat } from "./client.js";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatAgentClient } from "./client.js";

export type OpenAgents = {
  client: ChatAgentClient;
  onSetup?: () => void;
  onStartChat?: StartAgentChat;
  view?: "library" | "recipes";
};
type Navigation = {
  opened: OpenAgents | null;
  generation: number;
  getGeneration(): number;
  open(value: OpenAgents, trigger: HTMLButtonElement): void;
  close(restoreFocus?: boolean): void;
};
const Context = createContext<Navigation | null>(null);

function LocalWorkspace({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<OpenAgents | null>(null);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const getGeneration = useCallback(() => generationRef.current, []);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const open = useCallback((value: OpenAgents, element: HTMLButtonElement) => {
    generationRef.current += 1; setGeneration(generationRef.current);
    trigger.current = element;
    setOpened(value);
  }, []);
  const close = useCallback((restoreFocus = false) => {
    generationRef.current += 1; setGeneration(generationRef.current);
    setOpened(null);
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus();
  }, []);
  const value = useMemo(() => ({ opened, open, close, generation, getGeneration }), [opened, open, close, generation, getGeneration]);
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
