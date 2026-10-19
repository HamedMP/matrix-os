import "../../../packages/ui/src/chat-agents/chat-agents.css";
import React, { useContext, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import DesktopSurfaceFrame from "../../../desktop/src/renderer/src/features/desktop-shell/DesktopSurfaceFrame";
import WorkTab from "../../../desktop/src/renderer/src/features/work/WorkTab";
import { SharedChatSurface } from "../../../desktop/src/renderer/src/features/chat/SharedChatSurface";
import { BotDetailsContext, BotHeaderBindingContext, BotHeaderContext, SurfaceChromeContext, type SurfaceChromeSpec } from "../../../desktop/src/renderer/src/features/desktop-shell/SurfaceChrome";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel";
import { ChatAgentsWorkspace } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation";

export const bot = { id: "bot_header01", revision: 1, name: "Matrix Bot with a long saved display name",
  description: "Your personal Matrix assistant, using the identity and style you save in this computer with a long description.",
  recipeRef: { recipeId: "writer", version: "1" }, instructions: "Synthetic fixture only", archived: false,
  selection: { instanceId: "matrix_pi_default", model: "auto" }, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" };
const agents = { list: async () => ({ enabled: true, agents: [bot] }), bots: { directBot: async () => bot.id,
  interactions: async () => [], tasks: async () => [], authority: async () => ({ grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] }) } } as never;
const client = { agents, list: async () => ({ items: [] }) };
const runtime = { client, eventSource: null, projectedChatTitles: [], projectChat: () => undefined,
  agentDraftRequest: null, requestAgentDraft: () => true, consumeAgentDraft: () => undefined };
export function useWorkSurfaceRuntime() { return runtime; }
export function WorkSurfaceRuntimeProvider({ children }: { children: React.ReactNode }) { return <ChatAgentsWorkspace>{children}</ChatAgentsWorkspace>; }
export function TabErrorBoundary({ children }: { children: React.ReactNode }) { return children; }
export function TabPane({ tab }: { tab: { id: string; chatId: string; chatTitle: string } }) {
  const host = useContext(SurfaceChromeContext);
  const bridge = useMemo(() => host && ({ setChrome: (chrome: SurfaceChromeSpec | null) => host.setChrome(chrome && document.documentElement.dataset.leading === "true"
    ? { ...chrome, leftActions: <button className="size-7 shrink-0" aria-label="Back to Chat" onClick={() => { document.querySelector('#fixture-action')!.textContent = 'back'; }}>←</button> } : chrome) }), [host]);
  return <SurfaceChromeContext.Provider value={bridge}><WorkTab tabId={tab.id} active route="chat" initialChatId={tab.chatId} initialChatTitle={tab.chatTitle} initialChatView="conversation"/></SurfaceChromeContext.Provider>;
}
export function ChatContent({ initialChatId }: { initialChatId: string }) {
  const report = useContext(BotHeaderBindingContext), header = useContext(BotHeaderContext), details = useContext(BotDetailsContext);
  const ordinary = document.documentElement.dataset.surface === "ordinary";
  const [ready, setReady] = useState(document.documentElement.dataset.surface !== "handoff");
  useEffect(() => ready ? report?.({ chatId: initialChatId, client, status: ordinary ? "ordinary" : "bot", agentId: ordinary ? null : bot.id }) : undefined, [report, initialChatId, ordinary, ready]);
  return ordinary ? <textarea aria-label="Ordinary draft" defaultValue="Retained ordinary draft"/> :
    <SharedChatSurface ariaLabel="Global Chat" className="matrix-bot-chat-layout @container/bot-chat relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"><BotChatPanel chatId={initialChatId} directBotId={bot.id} client={agents} headerContainer={header} detailsContainer={details}>
      {!ready ? <button onClick={() => setReady(true)}>Resolve scoped binding</button> : null}<textarea aria-label="Bot draft" defaultValue="Retained bot draft"/>
    </BotChatPanel></SharedChatSurface>;
}
function Fixture() {
  const [width, setWidth] = useState(Number(document.documentElement.dataset.width ?? 320)), [action, setAction] = useState("");
  const standalone = document.documentElement.dataset.surface === "standalone";
  const ordinary = document.documentElement.dataset.surface === "ordinary";
  return <><button onClick={() => setWidth(width === 320 ? 900 : 320)}>Resize fixture</button><output id="fixture-action">{action}</output>
    {standalone ? <main id="header-fixture" className="relative" style={{ width, height: 400 }}>
      <BotChatPanel chatId="chat_header" directBotId={bot.id} client={agents}
        headerLeading={<button aria-label="Back to Chat" onClick={() => setAction("back")}>←</button>}><textarea aria-label="Bot draft" defaultValue="Retained bot draft"/></BotChatPanel>
    </main> : <DesktopSurfaceFrame tab={{ id: "header-fixture", kind: "work", title: "Chat", chatId: "chat_header", chatTitle: ordinary ? "Ordinary Chat" : bot.name, chatView: "conversation", workRoute: "chat", closable: true }}
      surface={{ tabId: "header-fixture", mode: document.documentElement.dataset.controls === "false" ? "tab" : "window", restoreMode: "window", bounds: { x: 20, y: 60, width, height: 400 }, zIndex: 1 }} active tabWorkspaceActive={document.documentElement.dataset.controls === "false"} overlayOpen={false} presentation="desktop"
      onFocus={() => undefined} onClose={() => setAction("close")} onMinimize={() => setAction("minimize")} onMaximize={() => setAction("maximize")} onBoundsChange={() => undefined}/>}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
