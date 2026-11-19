import "../../../packages/ui/src/chat-agents/chat-agents.css";
import "../../../packages/ui/src/chat/composer/chat-composer.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "../../../shell/src/components/ChatApp";
import { FileBrowser } from "../../../shell/src/components/file-browser/FileBrowser";
import { usePreviewWindow } from "../../../shell/src/hooks/usePreviewWindow";
import { organizationDriveNavigationIdentity } from "../../../shell/src/stores/organization-drive-navigation";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat";
import type { ChatAgentClient } from "@matrix-os/ui";

// Only the external catalog and owner API are synthetic. The ChatApp, composer,
// responsive controls and natural-language composer submission are real.
const fixtureParams = new URL(window.location.href).searchParams;
const empty = fixtureParams.get("empty") === "true";
const matrixFiles = fixtureParams.get("matrixFiles") === "true";
const pickerState = fixtureParams.get("pickerState");
window.fetch = async request => {
  if (matrixFiles) {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, window.location.origin);
    if (url.pathname === "/api/files/list") {
      const path = url.searchParams.get("path");
      if (pickerState === "error") return Response.json({ error: "fixture_unavailable" }, { status: 503 });
      if (pickerState === "empty") return Response.json({ path, entries: [] });
      const entries = path === "reports" ? [{ name: "selected.txt", type: "file" }] : [
        { name: "reports", type: "directory" }, { name: "dragged.txt", type: "file" },
      ];
      return Response.json({ path, entries });
    }
    if (url.pathname === "/api/file-previews/content") {
      return new Response(`Original ${url.searchParams.get("path")}`, { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/api/workspace/projects") return Response.json({ projects: [] });
  }
  return Response.json(createCanonicalProviderCatalogFixture());
};
const client = {
  bots: {
    directBot: async (chatId: string) => chatId === "chat_executor" ? "bot_existing" : null,
    directChat: async () => "chat_executor",
    routineOrigin: { get: async () => ({ sourceChatId: "chat_layout", pending: [], deliveries: [], hasMore: false }) },
    tasks: async () => [], interactions: async () => [],
  },
  list: async () => ({ enabled: true, agents: [{ id: "bot_existing", name: "Existing private Bot with a very long name for this narrow Chat window", recipeRef: { recipeId: "writer", version: "1" } }] }),
} as unknown as ChatAgentClient;

const root = document.getElementById("root")!;
const chat = <ChatApp
  messages={empty ? [] : [{ id: "msg_layout", role: "assistant", content: "Layout fixture ready", timestamp: 0 }]}
  sessionId="chat_layout" agentClient={client} busy={false} connected navigationFresh isCurrentAuthority={() => true}
  conversations={[]} onNewChat={() => undefined} onSwitchConversation={() => undefined} onSubmit={async (text, files, options) => {
    const hasRoutineCreation = options && Object.hasOwn(options, "routineCreation");
    root.dataset.lastSubmit = JSON.stringify({ text, ...(matrixFiles ? { files } : {}), ...(hasRoutineCreation ? { routineCreation: true } : {}) });
    return true;
  }}
  routineOriginChat={{ id: "chat_layout", ownerScope: { type: "personal", ownerId: "owner" }, lifecycle: "active" }}
/>;
if (matrixFiles) {
  usePreviewWindow.setState({ draftAuthority: organizationDriveNavigationIdentity(null, null, window.location.origin) });
}
createRoot(root).render(matrixFiles ? (
  <div className="grid h-full" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)" }}>
    <section aria-label="Matrix Files app" className="min-w-0 border-r"><FileBrowser windowId="fixture-files" active /></section>
    <section aria-label="Chat app" className="min-w-0 overflow-hidden">{chat}</section>
  </div>
) : chat);
