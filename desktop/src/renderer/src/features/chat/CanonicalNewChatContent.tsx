import type { ReactNode } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { cn } from "../../lib/cn";
import { ChatStarterCards } from "./ChatStarterCards";
import { ChatProviderOnboarding } from "./ChatProviderOnboarding";
import { PROJECT_LANDING_CONTENT_CLASS } from "../project/ProjectLanding";

/** Keeps the empty-state presentation separate from transcript and route orchestration. */
export function CanonicalNewChatContent({ projectId, showWelcome = projectId === null, workspaceLayout, composer, onSelect }: {
  projectId: string | null;
  showWelcome?: boolean;
  workspaceLayout: "narrow" | "wide";
  composer: ReactNode;
  onSelect: (prompt: string) => void;
}) {
  return showWelcome ? (
    <div
      data-slot="chat-new-chat-content"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div
        data-slot={projectId === null ? "chat-starter-scroll" : "chat-project-draft-scroll"}
        className={`flex min-h-0 flex-1 items-start justify-center overflow-y-auto ${workspaceLayout === "narrow" ? "px-3 py-3" : "px-5 pt-8 pb-[53px]"}`}
        style={{ scrollbarGutter: "stable both-edges" }}
      >
        <div
          data-slot="chat-starter-stack"
          className="@container/chat-home my-auto w-full max-w-[716px]"
        >
          <ChatProviderOnboarding>
            <div className="mb-4 grid justify-items-center gap-4 text-center">
              <span className="flex size-11 items-center justify-center rounded-full" style={{ background: "var(--text-primary)", color: "var(--bg-surface)" }}>
                <BrandLogo size={28} color="currentColor" className="block" testId="chat-welcome-matrix-logo" />
              </span>
              <h1 className="text-[26px] font-medium leading-[31px]" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
                What should we build today?
              </h1>
              <p className="text-[15px] leading-[22px]" style={{ color: "var(--text-tertiary)" }}>I’m Matrix. What should I start on?</p>
            </div>
            <ChatStarterCards
              layout="two-by-two"
              density={workspaceLayout === "narrow" ? "compact" : "regular"}
              onSelect={onSelect}
            />
          </ChatProviderOnboarding>
        </div>
      </div>
      <div className={cn("mx-auto w-full max-w-[808px] shrink-0", workspaceLayout === "narrow" ? "px-3 pb-3" : "px-6 pb-5")}>
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
