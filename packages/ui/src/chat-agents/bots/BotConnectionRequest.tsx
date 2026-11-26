import { readBotConnectionRequest, type BotConnectionRequest, type ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { AgentConnectionAction } from "../AgentConnectionAction.js";
import type { ChatAgentClient, ChatAgentIntegrationConnection, ChatAgentMcpServer } from "../client.js";

export type ConnectionRequestNavigation = (resource: "integrations" | "mcp") => void;
export type SubscribeToConnectionChanges = (refresh: () => void) => () => void;

export type SavedBotConnectionRequest = {
  chatId: string;
  agentId: string;
  runId: string;
  resource: BotConnectionRequest;
};

/** A legacy activity can trigger a read. Only the typed owner-turn result can offer Settings. */
export function useBotConnectionRequest(
  client: ChatAgentClient | undefined, chatId: string | undefined, agentId: string | null, runId?: string,
) {
  const [read, setRead] = useState<{ client: ChatAgentClient; request: SavedBotConnectionRequest } | null>(null);
  useEffect(() => {
    if (!client?.setupChat || !chatId || !agentId || !runId) return;
    const source = client.setupChat;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 60_000;
    const load = async () => {
      try {
        const detail = await source.detail(chatId);
        const { chat, projectId } = detail.record;
        if (!current || chat.id !== chatId || chat.ownerScope.type !== "personal"
          || chat.lifecycle !== "active" || chat.collaboration || projectId) return;
        const run = detail.runs.find(row => row.id === runId && row.chatId === chatId && row.driverKind === "matrix_bot"
          && row.instanceId === "matrix_bot_default");
        if (run?.status !== "completed") {
          if (run && run.status !== "failed" && run.status !== "aborted" && Date.now() < deadline) {
            timer = setTimeout(() => { void load(); }, 1500);
          }
          return;
        }
        const turn = detail.turns.find(row => row.id === run.turnId && row.chatId === chatId);
        const ownerId = chat.ownerScope.ownerId;
        if (!detail.messages.some(message => message.id === turn?.inputMessageId && message.chatId === chatId
          && message.role === "user" && message.state === "committed" && message.actorId === ownerId)) return;
        const activity = detail.activities.find(row => row.type === "bot.connection.requested" && row.chatId === chatId
          && row.runId === runId && row.sessionId === agentId);
        const resource = activity && readBotConnectionRequest(activity);
        if (resource) setRead({ client, request: { chatId, agentId, runId, resource } });
      } catch (failure: unknown) {
        if (current) console.warn("[bots] Connection request unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      }
    };
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [client, chatId, agentId, runId]);
  const request = read?.request;
  return read?.client === client && request?.chatId === chatId && request?.agentId === agentId && request?.runId === runId
    ? request : undefined;
}

interface ConnectionInventory {
  catalog: ChatAgentRecipeCatalog | null;
  connections: ChatAgentIntegrationConnection[];
  mcpServers: ChatAgentMcpServer[];
  status: "loading" | "loaded" | "unavailable";
}

export function SavedBotConnectionAction({ request, client, openSettings, subscribe, chooseIntegration }: {
  request: SavedBotConnectionRequest;
  client: ChatAgentClient;
  openSettings: ConnectionRequestNavigation;
  subscribe?: SubscribeToConnectionChanges;
  chooseIntegration?(): void;
}) {
  const [inventory, setInventory] = useState<ConnectionInventory>({ catalog: null, connections: [], mcpServers: [], status: "loading" });
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision(value => value + 1);
  const integration = request.resource.kind === "integration";
  const namedMcp = request.resource.kind === "mcp" && Boolean(request.resource.name);
  const readsInventory = integration || namedMcp;
  useEffect(() => {
    if (!readsInventory) return;
    let current = true;
    setInventory(previous => ({ ...previous, connections: [], mcpServers: [], status: "loading" }));
    void Promise.allSettled([
      integration ? client.recipeCatalog() : Promise.resolve(null),
      integration ? client.integrations() : Promise.resolve([]),
      namedMcp ? client.mcpServers?.() ?? Promise.resolve(null) : Promise.resolve(null),
    ]).then(([catalog, connections, mcpServers]) => {
      if (!current) return;
      const available = integration ? catalog.status === "fulfilled" && connections.status === "fulfilled"
        : mcpServers.status === "fulfilled" && mcpServers.value !== null;
      setInventory(previous => ({
        catalog: catalog.status === "fulfilled" ? catalog.value : previous.catalog,
        connections: connections.status === "fulfilled" ? connections.value : [],
        mcpServers: mcpServers.status === "fulfilled" ? mcpServers.value ?? [] : [],
        status: available ? "loaded" : "unavailable",
      }));
    });
    return () => { current = false; };
  }, [client, integration, namedMcp, readsInventory, revision]);

  useEffect(() => {
    if (!readsInventory) return;
    const reload = () => setRevision(value => value + 1);
    const unsubscribe = subscribe?.(reload);
    window.addEventListener("focus", reload);
    return () => { window.removeEventListener("focus", reload); unsubscribe?.(); };
  }, [readsInventory, subscribe]);

  return <AgentConnectionAction resource={request.resource} catalog={inventory.catalog} connections={inventory.connections} mcpServers={inventory.mcpServers}
    loading={readsInventory && inventory.status === "loading"} unavailable={inventory.status === "unavailable"}
    onOpenSettings={openSettings} onRefresh={readsInventory ? refresh : undefined} onChooseIntegration={chooseIntegration}/>;
}
