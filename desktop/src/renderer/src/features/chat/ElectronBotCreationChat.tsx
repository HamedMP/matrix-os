import { useMemo } from "react";
import { useCreationConversation, type BotCreationChatProps, type CreationConversationClient } from "@matrix-os/ui";
import type { CanonicalChatClient } from "../../lib/canonical-chat-client";
import { ConversationTranscript } from "../../components/conversation/transcript";
import { canonicalChatPresentation } from "./canonical-chat-presentation";
import { ElectronBotCreationComposer } from "./ElectronBotCreationComposer";

export function ElectronBotCreationChat({ creation, client }: { creation: BotCreationChatProps; client: CanonicalChatClient | null }) {
  const transport = useMemo<CreationConversationClient | null>(() => client ? {
    create: input => client.create(input), detail: chatId => client.getDetail(chatId),
    admitTurn: (chatId, input) => client.admitTurn(chatId, input),
    cancelRun: (chatId, runId, clientRequestId) => client.cancelRun(chatId, runId, { clientRequestId }),
  } : null, [client]);
  const conversation = useCreationConversation({ client: transport, snapshot: creation.snapshot, catalog: creation.catalog,
    isCurrent: creation.isCurrent, onProposal: proposal => proposal.sessionId === creation.snapshot.sessionId
      && creation.applyDraftChange(proposal.baseDraftRevision, proposal.patch) });
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <div className="flex min-h-0 flex-1" aria-hidden={!conversation.detail || undefined}>
      {conversation.detail ? <ConversationTranscript turns={canonicalChatPresentation(conversation.detail)} callbacks={{
        copyText: async text => {
          if (!navigator.clipboard?.writeText) throw new Error("ClipboardUnavailable");
          await navigator.clipboard.writeText(text);
        },
      }}/> : null}
    </div>
    {conversation.error ? <p role="alert" className="text-sm">{conversation.error}</p> : null}
    {!conversation.available ? <p role="status" className="text-xs">Matrix AI drafting is unavailable. You can use the form to continue.</p> : null}
    {creation.draftBar}
    {creation.catalog ? <div className="mx-auto w-full max-w-3xl">
      <ElectronBotCreationComposer scopeKey={creation.sessionId} catalog={creation.catalog} value={conversation.text}
        onChange={conversation.setText} onSubmit={conversation.send} pending={conversation.busy || creation.pending}
        available={conversation.available && !creation.pending} isCurrent={creation.isCurrent}
        onAbort={conversation.activeRunId ? () => { void conversation.abort(); } : undefined}/>
    </div> : null}
  </div>;
}
