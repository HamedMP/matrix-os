import type { ReactNode } from "react";
import { BrandLogo } from "../../design/BrandPanel";
import { cn } from "../../lib/cn";
import { ChatNewChatContent } from "@matrix-os/ui";
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
