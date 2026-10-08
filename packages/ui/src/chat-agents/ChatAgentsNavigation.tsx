import type { StartAgentChat } from "./client.js";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatAgentClient } from "./client.js";

export type OpenAgents = {
  client: ChatAgentClient;
  onSetup?: () => void;
  onStartChat?: StartAgentChat;
  view?: "library" | "recipes";
  title?: "Your AI team" | "New agent" | "Edit agent";
};
type BotDetailsRequest = {client: ChatAgentClient; chatId: string; agentId: string; sequence: number};
type Navigation = {
  detailsRequest: BotDetailsRequest | null;
  requestDetails(client: ChatAgentClient, chatId: string, agentId: string): void;
  consumeDetails(sequence: number): void;
  opened: OpenAgents | null;
  generation: number;
  getGeneration(): number;
  open(value: OpenAgents, trigger: HTMLButtonElement): void;
  close(restoreFocus?: boolean): void;
  setTitle(client: ChatAgentClient, generation: number, title: NonNullable<OpenAgents["title"]>): void;
};
const Context = createContext<Navigation | null>(null);

function LocalWorkspace({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<OpenAgents | null>(null);
  const [detailsRequest, setDetailsRequest] = useState<BotDetailsRequest | null>(null);
  const detailsSequence = useRef(0);
  const requestDetails = useCallback((client: ChatAgentClient, chatId: string, agentId: string) => {
    setDetailsRequest({client, chatId, agentId, sequence: ++detailsSequence.current});
  }, []);
  const consumeDetails = useCallback((sequence: number) => {
    setDetailsRequest(request => request?.sequence === sequence ? null : request);
  }, []);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const getGeneration = useCallback(() => generationRef.current, []);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const open = useCallback((value: OpenAgents, element: HTMLButtonElement) => {
    generationRef.current += 1; setGeneration(generationRef.current);
    setDetailsRequest(null);
    trigger.current = element;
    setOpened({ ...value, title: value.view === "recipes" ? "New agent" : "Your AI team" });
  }, []);
  const setTitle = useCallback((client: ChatAgentClient, ownerGeneration: number, title: NonNullable<OpenAgents["title"]>) => {
    if (generationRef.current !== ownerGeneration) return;
    setOpened(current => current?.client === client && current.title !== title ? { ...current, title } : current);
  }, []);
  const close = useCallback((restoreFocus = false) => {
    generationRef.current += 1; setGeneration(generationRef.current);
    setOpened(null);
    setDetailsRequest(null);
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus();
  }, []);
  const value = useMemo(() => ({ opened, open, close, generation, getGeneration, setTitle, detailsRequest, requestDetails, consumeDetails }), [opened, open, close, generation, getGeneration, setTitle, detailsRequest, requestDetails, consumeDetails]);
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
