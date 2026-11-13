import "../../../packages/ui/src/chat-agents/chat-agents.css";
import "../../../packages/ui/src/chat/composer/chat-composer.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "../../../shell/src/components/ChatApp";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat";
import type { ChatAgentClient } from "@matrix-os/ui";

// Only the external catalog and owner API are synthetic. The ChatApp, composer,
// responsive controls, destination picker and Persistent task choice are real.
window.fetch = async () => Response.json(createCanonicalProviderCatalogFixture());
const unset = new URL(window.location.href).searchParams.get("destination") === "unset";
const empty = new URL(window.location.href).searchParams.get("empty") === "true";
const client = {
  bots: {
    directBot: async (chatId: string) => chatId === "chat_executor" ? "bot_existing" : null,
    directChat: async () => "chat_executor",
    routineOrigin: { get: async () => ({ sourceChatId: "chat_layout", pending: [], deliveries: [], hasMore: false }) },
    routineDestination: { get: async () => unset ? ({ availability: "unset", preference: { revision: 0, target: null } }) : ({ availability: "available", preference: {
      revision: 1, target: { botId: "bot_existing", chatId: "chat_executor", bindingCreatedAt: "2026-11-06T00:00:00.000Z" },
      updatedAt: "2026-11-06T00:00:00.000Z",
    } }) },
    tasks: async () => [], interactions: async () => [],
  },
  list: async () => ({ enabled: true, agents: [{ id: "bot_existing", name: "Existing private Bot with a very long name for this narrow Chat window", recipeRef: { recipeId: "writer", version: "1" } }] }),
} as unknown as ChatAgentClient;

createRoot(document.getElementById("root")!).render(<ChatApp
  messages={empty ? [] : [{ id: "msg_layout", role: "assistant", content: "Layout fixture ready", timestamp: 0 }]}
  sessionId="chat_layout" agentClient={client} busy={false} connected navigationFresh isCurrentAuthority={() => true}
  conversations={[]} onNewChat={() => undefined} onSwitchConversation={() => undefined} onSubmit={async () => true}
  routineFullAccessChat={{ id: "chat_layout", ownerScope: { type: "personal", ownerId: "owner" }, lifecycle: "active" }}
/>);
