import type { ReactNode } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { cn } from "../../lib/cn";
import { ChatNewChatContent } from "@matrix-os/ui";
import { ChatProviderOnboarding } from "./ChatProviderOnboarding";
import { PROJECT_LANDING_CONTENT_CLASS } from "../project/ProjectLanding";
import { ConversationTranscript } from "../../components/conversation/transcript";
import type { ConversationTurnPresentation } from "../../components/conversation/presentation";

/**
 * Keeps the empty-state presentation separate from transcript and route
 * orchestration. Once the first message is sent it shows as the transcript
 * (`pending`) while the Chat is created and its turn admitted.
 */
export function CanonicalNewChatContent({ projectId, showWelcome = projectId === null, workspaceLayout, composer, onSelect, pending }: {
  projectId: string | null;
  showWelcome?: boolean;
  workspaceLayout: "narrow" | "wide";
  composer: ReactNode;
  onSelect: (prompt: string) => void;
  pending?: { turns: ConversationTurnPresentation[]; copyText: (text: string) => Promise<void> };
}) {
  if (pending?.turns.length) return (
    <div data-slot="chat-pending-draft" className="flex min-h-0 flex-1 flex-col">
      <ConversationTranscript turns={pending.turns} callbacks={{ copyText: pending.copyText }} />
      <div className="mx-auto w-full max-w-[808px] shrink-0 px-6 pb-5">{composer}</div>
    </div>
  );
  return showWelcome ? (
    <ChatNewChatContent
      logo={<BrandLogo size={28} color="currentColor" className="block" testId="chat-welcome-matrix-logo" />}
      layout={workspaceLayout}
      inProject={projectId !== null}
      composer={composer}
      wrapHero={(children) => <ChatProviderOnboarding>{children}</ChatProviderOnboarding>}
      onSelect={onSelect}
    />
  ) : (
    <div className={cn("flex min-h-0 flex-col pb-5", PROJECT_LANDING_CONTENT_CLASS)}>
      <div data-slot="chat-project-draft-scroll" className="min-h-0 overflow-y-auto"><ChatProviderOnboarding /></div>
      <div className="shrink-0">{composer}</div>
    </div>
  );
}
