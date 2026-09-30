import type { ReactNode } from "react";
import { MessageSquare } from "@renderer/lib/hugeicons";
import { CHAT_CONTENT_WIDTH_CLASS } from "../../components/conversation/layout";
import { cn } from "../../lib/cn";
import { ChatStarterCards } from "./ChatStarterCards";
import { ChatProviderOnboarding } from "./ChatProviderOnboarding";

/** Keeps the empty-state presentation separate from transcript and route orchestration. */
export function CanonicalNewChatContent({ projectId, workspaceLayout, composer, onSelect }: {
  projectId: string | null;
  workspaceLayout: "narrow" | "wide";
  composer: ReactNode;
  onSelect: (prompt: string) => void;
}) {
  return projectId === null ? (
    <div
      data-slot="chat-new-chat-content"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div
        data-slot="chat-starter-scroll"
        className={`flex min-h-0 flex-1 justify-center ${workspaceLayout === "narrow" ? "items-start overflow-y-auto px-3 py-3" : "items-center px-5 py-8"}`}
        style={workspaceLayout === "narrow" ? { scrollbarGutter: "stable" } : undefined}
      >
        <div
          data-slot="chat-starter-stack"
          className={`w-full max-w-[480px] ${workspaceLayout === "narrow" ? "my-auto" : ""}`}
        >
          <ChatProviderOnboarding><ChatStarterCards
            layout="two-by-two"
            density={workspaceLayout === "narrow" ? "compact" : "regular"}
            onSelect={onSelect}
          /></ChatProviderOnboarding>
        </div>
      </div>
      <div className={cn("mx-auto w-full shrink-0", CHAT_CONTENT_WIDTH_CLASS, workspaceLayout === "narrow" ? "px-3 pb-3" : "px-5 pb-5")}>
        {composer}
      </div>
    </div>
  ) : (
    <div className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col justify-center", CHAT_CONTENT_WIDTH_CLASS, workspaceLayout === "narrow" ? "gap-3 overflow-y-auto px-3 py-3" : "gap-[26px] px-5 py-8")}>
      <ChatProviderOnboarding><div className="flex flex-col items-center gap-3 text-center">
        <MessageSquare size={28} aria-hidden style={{ color: "var(--text-tertiary)" }} />
        <h1 className="text-[24px] font-medium leading-[32px]" style={{ color: "var(--text-primary)" }}>
          What should we build today?
        </h1>
      </div>
      <ChatStarterCards
        layout="two-by-two"
        density={workspaceLayout === "narrow" ? "compact" : "regular"}
        onSelect={onSelect}
      /></ChatProviderOnboarding>
      {composer}
    </div>
  );
}
