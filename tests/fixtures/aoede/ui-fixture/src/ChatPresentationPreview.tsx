import { useState } from "react";
import { ChatPresentation, MatrixChatAvatar } from "../../../../../packages/ui/src/chat/ChatPresentation";
import { ChatHistory } from "../../../../../packages/ui/src/chat/ChatHistory";
import { ChatStarterCards } from "../../../../../packages/ui/src/chat/ChatStarterCards";

/** Visual fixture only. Real Web/Electron host wiring is covered separately. */
export function ChatPresentationPreview() {
  const [id, setId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const items = [
    { id: "chat_task", title: "Build a launch website", updatedAt: 1, conversationKind: "chat" as const },
    { id: "chat_voice", title: "Plan the launch week", updatedAt: 2, conversationKind: "voice" as const },
  ];
  return <ChatPresentation style={{ position: "absolute", inset: "6% 10%", display: "flex", overflow: "hidden", borderRadius: 16, boxShadow: "0 16px 40px -8px rgb(0 0 0 / .22)" }}>
    <aside style={{ width: 240, flexShrink: 0, borderRight: "1px solid var(--chat-border)" }}>
      <ChatHistory items={items} activeChatId={id} onSelect={setId} onNewChat={() => setId(null)} />
    </aside>
    <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: 16, borderBottom: "1px solid var(--chat-border)" }}><MatrixChatAvatar /><strong style={{ fontWeight: 500 }}>Matrix</strong></header>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        {id ? <div style={{ width: "100%", maxWidth: 600 }}><p data-chat-message="user">Help me plan the launch week.</p><p data-chat-message="assistant">Which day should we start with?</p></div>
          : <div style={{ width: 480, maxWidth: "100%" }}><ChatStarterCards layout="two-by-two" onSelect={setDraft} /></div>}
      </div>
      <div data-chat-composer style={{ margin: 20, padding: 16 }}>
        <textarea aria-label="Fixture chat draft" placeholder="Or type what you need…" value={draft} onChange={e => setDraft(e.target.value)} style={{ width: "100%", border: 0, resize: "none", background: "transparent", outline: "none" }} />
      </div>
    </main>
  </ChatPresentation>;
}
