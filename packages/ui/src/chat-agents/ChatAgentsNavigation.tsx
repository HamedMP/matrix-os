import type { StartAgentChat } from "./client.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatAgentClient } from "./client.js";

export type OpenAgents = {
  client: ChatAgentClient;
  requestId?: string;
  onSetup?: () => void;
  onStartChat?: StartAgentChat;
  view?: "library" | "recipes";
  title?: "Your AI team" | "New agent" | "Edit agent";
  requestedRecipeId?: string;
  onRequestedRecipeResult?: (result: { ok: true } | { ok: false; error: "recipe_unavailable" | "navigation_unavailable" }) => void;
};
type BotDetailsRequest = {client: ChatAgentClient; chatId: string; agentId: string; sequence: number};
type Navigation = {
  detailsRequest: BotDetailsRequest | null;
  requestDetails(client: ChatAgentClient, chatId: string, agentId: string): void;
  consumeDetails(sequence: number): void;
  opened: OpenAgents | null;
  generation: number;
  getGeneration(): number;
  getOpened(): OpenAgents | null;
  open(value: OpenAgents, trigger?: HTMLButtonElement): void;
  close(restoreFocus?: boolean): void;
  cancelRequest(requestId: string): void;
  setTitle(client: ChatAgentClient, generation: number, title: NonNullable<OpenAgents["title"]>): void;
};
const Context = createContext<Navigation | null>(null);

function LocalWorkspace({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<OpenAgents | null>(null);
  const openedRef = useRef<OpenAgents | null>(null);
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
  const getOpened = useCallback(() => openedRef.current, []);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const open = useCallback((value: OpenAgents, element?: HTMLButtonElement) => {
    generationRef.current += 1; setGeneration(generationRef.current);
    setDetailsRequest(null);
    trigger.current = element ?? null;
    const next = { ...value, title: value.view === "recipes" ? "New agent" as const : "Your AI team" as const };
    openedRef.current = next;
    setOpened(next);
  }, []);
  const setTitle = useCallback((client: ChatAgentClient, ownerGeneration: number, title: NonNullable<OpenAgents["title"]>) => {
    if (generationRef.current !== ownerGeneration) return;
    setOpened(current => current?.client === client && current.title !== title ? { ...current, title } : current);
  }, []);
  const close = useCallback((restoreFocus = false) => {
    generationRef.current += 1; setGeneration(generationRef.current);
    openedRef.current = null;
    setOpened(null);
    setDetailsRequest(null);
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus();
  }, []);
  const cancelRequest = useCallback((requestId: string) => {
    if (openedRef.current?.requestId === requestId) close();
  }, [close]);
  const value = useMemo(() => ({ opened, open, close, cancelRequest, generation, getGeneration, getOpened, setTitle, detailsRequest, requestDetails, consumeDetails }), [opened, open, close, cancelRequest, generation, getGeneration, getOpened, setTitle, detailsRequest, requestDetails, consumeDetails]);
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

/**
 * A draft put into Chat's composer from elsewhere (Getting started's Try, Create app, New chat)
 * closes Agents, so the composer it went to shows. `request` identifies the draft request; only
 * a new one closes Agents, never the one already pending when this mounts.
 */
export function useCloseAgentsOnDraftRequest(request: number | null | undefined): void {
  const close = useContext(Context)?.close;
  const handled = useRef(request);
  useEffect(() => {
    if (!request || request === handled.current) return;
    handled.current = request;
    close?.();
  }, [close, request]);
}
