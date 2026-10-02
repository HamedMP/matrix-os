import type { ReactNode } from "react";
import { AgentAvatar } from "@matrix-os/ui";
import { cn } from "../../lib/cn";
import { ChatStarterCards } from "./ChatStarterCards";
import { ChatProviderOnboarding } from "./ChatProviderOnboarding";
import { PROJECT_LANDING_CONTENT_CLASS } from "../project/ProjectLanding";

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
        className={`flex min-h-0 flex-1 items-start justify-center overflow-y-auto ${workspaceLayout === "narrow" ? "px-3 py-3" : "px-5 py-8"}`}
        style={{ scrollbarGutter: "stable" }}
      >
        <div
          data-slot="chat-starter-stack"
          className="@container/chat-home my-auto w-full max-w-[640px]"
        >
          <ChatProviderOnboarding><div className="mb-7 grid justify-items-center gap-2 text-center"><AgentAvatar id="matrix_home" name="Matrix"/><h1 className="text-[24px] font-medium leading-[32px]" style={{ color: "var(--text-primary)" }}>What should we build today?</h1><p className="text-sm" style={{ color: "var(--text-tertiary)" }}>I’m Matrix. What should I start on?</p></div><ChatStarterCards
            layout="two-by-two"
            density={workspaceLayout === "narrow" ? "compact" : "regular"}
            onSelect={onSelect}
          /></ChatProviderOnboarding>
        </div>
      </div>
      <div className={cn("mx-auto w-full max-w-3xl shrink-0", workspaceLayout === "narrow" ? "px-3 pb-3" : "px-6 pb-5")}>
        {composer}
      </div>
    </div>
  ) : (
    <div className={cn("flex min-h-0 flex-1 flex-col pb-5", PROJECT_LANDING_CONTENT_CLASS)}>
      <div data-slot="chat-project-draft-scroll" className="flex min-h-0 flex-1 flex-col overflow-y-auto"><ChatProviderOnboarding><div className="flex-1" /></ChatProviderOnboarding></div>
      <div className="shrink-0">{composer}</div>
    </div>
  );
}
