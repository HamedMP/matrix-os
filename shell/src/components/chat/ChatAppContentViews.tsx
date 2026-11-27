import type React from "react";
import type { ChatAgentDraftRequest } from "@matrix-os/ui";
import { ChatComposerColumn, ChatNewChatContent, ChatAttachments } from "@matrix-os/ui";
import { ChatInput } from "./ChatInput";
import { ChatProviderOnboarding } from "../chat-provider-onboarding";
import type { ChatMessage } from "@/lib/chat";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { RichContent } from "@/components/ui-blocks";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Plan } from "@/components/ai-elements/plan";
import { Task } from "@/components/ai-elements/task";
import { extractThinking } from "@/components/ai-elements/reasoning-utils";
import { parsePlan } from "@/components/ai-elements/plan-utils";
import { parseTask } from "@/components/ai-elements/task-utils";
// The Matrix glyph Electron Desktop shows on a new Chat, drawn from the shipped logo.
const NEW_CHAT_LOGO_STYLE = {
  width: Math.round((28 * 510) / 660),
  height: 28,
  background: "currentColor",
  WebkitMask: "url('/matrix-logo.svg') no-repeat center / contain",
  mask: "url('/matrix-logo.svg') no-repeat center / contain",
} as const;

export function EmptyState({
  composerProps,
  composerKey,
  onSubmit,
  connected,
  pending,
  mobile,
  composerDraftRequest,
  onComposerDraftConsumed,
  providerReady,
  attachmentsEnabled,
  projectHome,
}: {
  composerProps: Pick<
    React.ComponentProps<typeof ChatInput>,
    | "leadingControls"
    | "toolbarControls"
    | "queue"
    | "composer"
    | "agentClient"
    | "scope"
    | "permissionMode"
    | "driveContextEnabled"
    | "botContext"
    | "botControls"
    | "botConsentResources"
    | "botRequiresFullAccess"
    | "onOpenBotMention"
    | "slashInstance"
    | "slashCatalogLoading"
    | "projectSlash"
    | "isCurrentAuthority"
    | "matrixGatewayUrl"
    | "attachmentPolicy"
  >;
  composerKey: string;
  onSubmit: React.ComponentProps<typeof ChatInput>["onSubmit"];
  connected: boolean;
  pending: boolean;
  mobile: boolean;
  composerDraftRequest?: ChatAgentDraftRequest | null;
  onComposerDraftConsumed?: (id: number) => void;
  providerReady: boolean;
  attachmentsEnabled: boolean;
  projectHome?: React.ReactNode;
}) {
  const layout = mobile ? "narrow" : "wide";
  const input = (
    <ChatInput
      key={composerKey}
      {...composerProps}
      connected={connected && providerReady}
      busy={pending}
      onSubmit={onSubmit}
      autoFocus={!mobile && !projectHome}
      placeholder="How can I help you today?"
      draftRequest={composerDraftRequest}
      onDraftConsumed={onComposerDraftConsumed}
      unavailablePlaceholder={!providerReady ? "Write or dictate a draft — connect a harness to send" : undefined}
      attachmentsEnabled={attachmentsEnabled}
    />
  );
  if (projectHome) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {projectHome}
        <ChatComposerColumn layout={layout}>{input}</ChatComposerColumn>
      </div>
    );
  }
  return (
    <ChatNewChatContent
      logo={
        <span aria-hidden="true" data-testid="chat-welcome-matrix-logo" className="block" style={NEW_CHAT_LOGO_STYLE} />
      }
      layout={layout}
      wrapHero={(children) => <ChatProviderOnboarding>{children}</ChatProviderOnboarding>}
      onSelect={(prompt) => composerProps.composer.setText(prompt)}
      composer={input}
    />
  );
}

export function AssistantBubble({
  content,
  attachments,
  openAttachment,
  openFile,
  loadImage,
  onAction,
}: {
  content: string;
  attachments?: ChatMessage["attachments"];
  openAttachment?: (path: string) => boolean | void;
  openFile?: (path: string) => boolean | void;
  loadImage?: (src: string) => Promise<Blob>;
  onAction?: (text: string) => void;
}) {
  const { thinking, rest } = extractThinking(content);
  const planSteps = parsePlan(rest);
  const taskData = parseTask(rest);
  const displayContent = planSteps
    ? rest.replace(/```plan\n[\s\S]*?```/, "").trim()
    : taskData
      ? rest.replace(/```task\n[\s\S]*?```/, "").trim()
      : rest;

  return (
    <Message from="assistant">
      <MessageContent>
        {attachments?.length ? (
          <ChatAttachments align="start" attachments={attachments} open={openAttachment} loadImage={loadImage} />
        ) : null}
        {thinking && <Reasoning content={thinking} />}
        {planSteps && <Plan steps={planSteps} />}
        {taskData && <Task task={taskData} />}
        {displayContent && (
          <RichContent onAction={onAction} openFile={openFile ?? openAttachment}>
            {displayContent}
          </RichContent>
        )}
      </MessageContent>
    </Message>
  );
}
