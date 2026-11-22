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
export function CanonicalNewChatContent({ projectId, showWelcome = projectId === null, workspaceLayout, composer, onSelect, pending, introduction }: {
  introduction?: ReactNode;
  projectId: string | null;
  showWelcome?: boolean;
  workspaceLayout: "narrow" | "wide";
  composer: ReactNode;
  onSelect: (prompt: string) => void;
  pending?: { turns: ConversationTurnPresentation[]; copyText: (text: string) => Promise<void> };
}) {
  if (introduction) return <div className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto">{introduction}</div>
    <div className={cn("mx-auto w-full shrink-0 px-6 pb-5", PROJECT_LANDING_CONTENT_CLASS)}>{composer}</div>
  </div>;
  // The pending transcript replaces only the area above the composer, so the
  // composer keeps its draft state (selected skills) if the send fails.
  const transcript = pending?.turns.length
    ? <ConversationTranscript turns={pending.turns} callbacks={{ copyText: pending.copyText }} /> : undefined;
  return showWelcome ? (
    <ChatNewChatContent
      logo={<BrandLogo size={28} color="currentColor" className="block" testId="chat-welcome-matrix-logo" />}
      layout={workspaceLayout}
      inProject={projectId !== null}
      composer={composer}
      wrapHero={(children) => <ChatProviderOnboarding>{children}</ChatProviderOnboarding>}
      onSelect={onSelect}
      body={transcript}
    />
  ) : (
    <div className={cn("flex min-h-0 flex-col pb-5", transcript && "flex-1", PROJECT_LANDING_CONTENT_CLASS)}>
      {transcript ?? <div data-slot="chat-project-draft-scroll" className="min-h-0 overflow-y-auto"><ChatProviderOnboarding /></div>}
      <div className="shrink-0">{composer}</div>
    </div>
  );
}
