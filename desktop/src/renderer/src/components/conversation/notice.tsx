import { BotModelFailureNotice, ChatNoticeCard, useBotModelRecovery } from "@matrix-os/ui";
import { ConversationItem } from "./conversation";
import { Message, MessageContent, MessageResponse } from "./message";
import type { ConversationActionPresentation, ConversationNoticePresentation, ConversationPresentationCallbacks } from "./presentation";

function actionKey(action: ConversationActionPresentation): string {
  return action.kind === "recovery" ? `recovery:${action.recovery}` : `${action.kind}:${action.label}`;
}

export function ConversationNotice({
  notice,
  callbacks,
}: {
  notice: ConversationNoticePresentation;
  callbacks: ConversationPresentationCallbacks;
}) {
  const failed = notice.tone === "failed";
  const botRecovery = useBotModelRecovery();
  const availableActions = (notice.actions ?? []).filter((action) => (
    callbacks.performAction && (!callbacks.canPerformAction || callbacks.canPerformAction(action))
  ));
  if (failed && notice.failureCode === "model_unavailable" && botRecovery) return <ConversationItem messageId={`notice:${notice.id}`}><Message><MessageContent><BotModelFailureNotice/></MessageContent></Message></ConversationItem>;
  return (
    <ConversationItem messageId={`notice:${notice.id}`}>
      <Message>
        <MessageContent>
          <ChatNoticeCard
            label={notice.label}
            failed={failed}
            actions={availableActions.map((action) => ({ key: actionKey(action), label: action.label }))}
            onAction={callbacks.performAction ? async (key) => {
              const action = availableActions.find((candidate) => actionKey(candidate) === key);
              if (action) await callbacks.performAction?.(action, undefined);
            } : undefined}
          >
            <MessageResponse copyText={callbacks.copyText} openFile={callbacks.openFile} openWebLink={callbacks.openWebLink}>{notice.markdown}</MessageResponse>
          </ChatNoticeCard>
        </MessageContent>
      </Message>
    </ConversationItem>
  );
}
