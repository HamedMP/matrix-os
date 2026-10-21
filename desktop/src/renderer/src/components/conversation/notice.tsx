import { useState } from "react";
import { BotModelFailureNotice, useBotModelRecovery } from "@matrix-os/ui";
import { CircleAlert } from "@renderer/lib/hugeicons";
import { ConversationItem } from "./conversation";
import { Message, MessageContent, MessageResponse } from "./message";
import type { ConversationNoticePresentation, ConversationPresentationCallbacks } from "./presentation";

export function ConversationNotice({
  notice,
  callbacks,
}: {
  notice: ConversationNoticePresentation;
  callbacks: ConversationPresentationCallbacks;
}) {
  const failed = notice.tone === "failed";
  const botRecovery = useBotModelRecovery();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const availableActions = (notice.actions ?? []).filter((action) => (
    callbacks.performAction && (!callbacks.canPerformAction || callbacks.canPerformAction(action))
  ));
  const perform = async (action: typeof availableActions[number]) => {
    if (!callbacks.performAction || pendingAction) return;
    setPendingAction(action.kind);
    setActionFailed(false);
    try {
      await callbacks.performAction(action, undefined);
    } catch (error) {
      console.warn("[conversation] action failed:", error instanceof Error ? error.name : "UnknownError");
      setActionFailed(true);
    } finally {
      setPendingAction(null);
    }
  };
  if (failed && notice.failureCode === "model_unavailable" && botRecovery) return <ConversationItem messageId={`notice:${notice.id}`}><Message><MessageContent><BotModelFailureNotice/></MessageContent></Message></ConversationItem>;
  return (
    <ConversationItem messageId={`notice:${notice.id}`}>
      <Message>
        <MessageContent>
          <div
              role="status"
              aria-label={notice.label}
              className={`w-fit min-w-[20rem] max-w-full rounded-xl border px-3 py-2.5 text-sm sm:max-w-[42rem] ${failed ? "flex items-start gap-2.5" : ""}`}
              style={{
                borderColor: failed ? "var(--danger)" : "var(--border-default)",
                color: "var(--text-primary)",
              }}
            >
              {failed ? (
                <CircleAlert
                  size={16}
                  aria-hidden
                  className="mt-0.5 shrink-0"
                  style={{ color: "var(--danger)" }}
                />
              ) : null}
              <div className="min-w-0">
                <p className="font-medium leading-5">{notice.label}</p>
                <div className="mt-0.5 leading-5" style={{ color: "var(--text-secondary)" }}>
                  <MessageResponse copyText={callbacks.copyText} openFile={callbacks.openFile} openWebLink={callbacks.openWebLink}>{notice.markdown}</MessageResponse>
                </div>
                {availableActions.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {availableActions.map((action) => (
                      <button
                        key={`${action.kind}:${action.label}`}
                        type="button"
                        aria-label={`${action.label} ${notice.label}`}
                        disabled={pendingAction !== null}
                        className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
                        style={{ borderColor: "var(--border-default)" }}
                        onClick={() => void perform(action)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {actionFailed ? <p role="alert" className="mt-1 text-xs">The action failed. Try again.</p> : null}
              </div>
          </div>
        </MessageContent>
      </Message>
    </ConversationItem>
  );
}
