"use client";
import { useCreationConversation, type BotCreationChatProps, type CreationConversationClient } from "@matrix-os/ui";
import { WebBotCreationComposer } from "./WebBotCreationComposer";
import { WebCreationTranscript } from "./WebCreationTranscript";

export function WebBotCreationChat({ creation, client, connected }: {
  creation: BotCreationChatProps; client: CreationConversationClient | null; connected: boolean;
}) {
  const conversation = useCreationConversation({ client, snapshot: creation.snapshot, catalog: creation.catalog,
    isCurrent: creation.isCurrent, onProposal: proposal => proposal.sessionId === creation.snapshot.sessionId
      && creation.applyDraftChange(proposal.baseDraftRevision, proposal.patch) });
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <div className="flex min-h-0 flex-1" aria-hidden={!conversation.detail || undefined}>
      {conversation.detail ? <WebCreationTranscript detail={conversation.detail}/> : null}
    </div>
    {conversation.error ? <p role="alert" className="text-sm">{conversation.error}</p> : null}
    {!conversation.available ? <p role="status" className="text-xs">Matrix AI drafting is unavailable. You can use the form to continue.</p> : null}
    {creation.draftBar}
    <div className="mx-auto w-full max-w-3xl">
      <WebBotCreationComposer scopeKey={creation.sessionId} value={conversation.text} onChange={conversation.setText}
        onSubmit={conversation.send} pending={conversation.busy || creation.pending}
        available={connected && conversation.available && !creation.pending} isCurrent={creation.isCurrent}
        activeRunId={conversation.activeRunId ?? undefined} onAbort={conversation.activeRunId ? () => { void conversation.abort(); } : undefined}/>
    </div>
  </div>;
}
