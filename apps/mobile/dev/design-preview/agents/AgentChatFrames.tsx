import { useState, type ReactNode } from "react";

import { AgentChatScreen } from "@/components/agents/AgentChatScreen";
import { AgentDetailsSheet } from "@/components/agents/AgentDetailsSheet";
import { ApprovalCard } from "@/components/agents/interactions/ApprovalCard";
import { ResultCard } from "@/components/chat/ResultCard";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";

import {
  SAMPLE_AGENT,
  SAMPLE_AGENT_AUTHORITY,
  SAMPLE_AGENT_CHAT,
  SAMPLE_AGENT_RESULT,
  SAMPLE_APPROVAL,
  SAMPLE_APPROVAL_CHAT,
  SAMPLE_RUNS_ON,
} from "./sample-agent-chat";

function noop() {}

async function nothing() {}

/** Frame A2: an agent's chat. */
export function AgentChatFrame() {
  return <AgentChatSample messages={SAMPLE_AGENT_CHAT} />;
}

/** Frame A3: an action waiting for the person at the end of the chat. */
export function AgentApprovalFrame() {
  return (
    <AgentChatSample
      messages={SAMPLE_APPROVAL_CHAT}
      footer={<ApprovalCard testID="agent-approval-sample" {...SAMPLE_APPROVAL} onAllow={noop} onDeny={noop} />}
    />
  );
}

/** Frame A4: the details sheet open over the agent's chat. */
export function AgentDetailsFrame() {
  return <AgentChatSample messages={SAMPLE_AGENT_CHAT} detailsOpen />;
}

function renderSampleResult(message: TranscriptMessage): ReactNode {
  return message.id === SAMPLE_AGENT_RESULT.messageId ? <ResultCard app={SAMPLE_AGENT_RESULT.app} onOpen={noop} /> : null;
}

function AgentChatSample({ messages, footer, detailsOpen = false }: {
  messages: TranscriptMessage[];
  footer?: ReactNode;
  detailsOpen?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [details, setDetails] = useState(detailsOpen);

  return (
    <>
      <AgentChatScreen
        agent={SAMPLE_AGENT}
        state="ready"
        onBack={noop}
        onOpenDetails={() => setDetails(true)}
        onRetry={noop}
        messages={messages}
        chatId="sample-agent-chat"
        renderResults={renderSampleResult}
        footer={footer}
        composer={{ draft, onChangeDraft: setDraft, canSend: draft.trim().length > 0, onSend: noop }}
      />
      <AgentDetailsSheet
        visible={details}
        onClose={() => setDetails(false)}
        agent={SAMPLE_AGENT}
        runsOn={SAMPLE_RUNS_ON}
        authority={SAMPLE_AGENT_AUTHORITY}
        tasks={[]}
        actionsAvailable
        onRevoke={nothing}
        onMemory={nothing}
        onRefresh={nothing}
        archiving={false}
        onArchive={noop}
      />
    </>
  );
}
