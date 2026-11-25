/**
 * The Mail agent side panel: quick actions for the open thread and the
 * selection, a free-text prompt, and reviewable results. Put it in
 * `AppFrame`'s `rightPanel`.
 *
 *   <MailAgentPanel agent={agent} store={store} onClose={hide} onShowComposer={show} />
 *
 * Drafts open in the composer as proposals; triage suggestions apply only on
 * the owner's click; bulk drafts send only through ConfirmSend.
 */
import { useMemo, useState } from "react";
import { AgentPanel, type AgentResult } from "../../../../_shared/office-ui";
import type { MailAgent, MailAgentState, PanelItem } from "../../agent/controller";
import type { DraftProposal } from "../../agent/proposals";
import type { MailState, MailStore } from "../../model";
import { BulkDraftsDialog } from "./BulkDraftsDialog";
import { DraftBody, SearchBody, SummaryBody, TriageBody } from "./ResultBodies";
import { useExternal } from "./use-external";
import "./mail-agent.css";

export interface MailAgentPanelProps {
  /** Null when the host has no AI; the panel then explains that. */
  agent: MailAgent | null;
  store: MailStore;
  onClose?: () => void;
  /** Called after a draft opens so the app can show the composer. */
  onShowComposer?: () => void;
  /** Rows handed in from a sheet range; opens the bulk dialog with them. */
  bulkRows?: readonly (readonly unknown[])[] | null;
  onBulkRowsConsumed?: () => void;
}

const EMPTY_STATE: MailAgentState = { busy: false, task: null, messages: [], status: [], items: [], error: null };
const NO_PROPOSALS: readonly DraftProposal[] = [];

function resultFor(
  item: PanelItem,
  proposals: readonly DraftProposal[],
  agent: MailAgent,
  onShowComposer: (() => void) | undefined,
): AgentResult | null {
  switch (item.kind) {
    case "draft": {
      const proposal = proposals.find((p) => p.id === item.proposalId);
      if (!proposal) return null;
      return {
        id: item.id,
        title: `${proposal.kind === "reply" ? "Reply draft" : "New draft"}: ${proposal.subject || "(no subject)"}`,
        meta: proposal.to.length ? `To ${proposal.to.join(", ")}` : "No recipients yet",
        status: proposal.status,
        body: (
          <DraftBody
            proposal={proposal}
            onKeep={() => {
              agent.keepDraft(proposal.id);
              onShowComposer?.();
            }}
            onDiscard={() => void agent.discardDraft(proposal.id)}
          />
        ),
      };
    }
    case "summary":
      return { id: item.id, title: `Summary: ${item.digest.subject || "(no subject)"}`, meta: `${item.digest.messageCount} messages`, status: "proposed", body: <SummaryBody digest={item.digest} /> };
    case "search":
      return {
        id: item.id,
        title: `Search: ${item.question}`,
        meta: `${item.result.results.length} found with ${item.result.queries.length} queries`,
        status: "proposed",
        body: <SearchBody result={item.result} onOpen={(hit) => void agent.openResult(hit)} />,
      };
    case "triage":
      return {
        id: item.id,
        title: "Triage suggestions",
        meta: `${item.suggestions.length} ${item.suggestions.length === 1 ? "conversation" : "conversations"}`,
        status: item.status === "applied" ? "accepted" : item.status === "dismissed" ? "rejected" : "proposed",
        body: (
          <TriageBody
            suggestions={item.suggestions}
            status={item.status}
            outcome={item.outcome}
            onToggle={(id, selected) => agent.toggleTriage(item.id, id, selected)}
            onApply={() => void agent.applyTriage(item.id)}
            onDismiss={() => agent.dismissTriage(item.id)}
          />
        ),
      };
  }
}

export function MailAgentPanel({ agent, store, onClose, onShowComposer, bulkRows, onBulkRowsConsumed }: MailAgentPanelProps) {
  const state = useExternal(agent, (a) => (a as MailAgent).getState(), EMPTY_STATE);
  const proposals = useExternal(agent?.context.proposals, (p) => (p as { list(): readonly DraftProposal[] }).list(), NO_PROPOSALS);
  const mail = useExternal(store, (s) => (s as MailStore).getSnapshot(), store.getSnapshot()) as MailState;
  const [bulkOpen, setBulkOpen] = useState(false);
  const hasThread = Boolean(mail.openThread);
  const selected = mail.selection.keys.length;
  const showBulk = bulkOpen || Boolean(bulkRows?.length);

  const results = useMemo(
    () => (agent ? state.items.map((item) => resultFor(item, proposals, agent, onShowComposer)).filter((r): r is AgentResult => r !== null) : []),
    [agent, state.items, proposals, onShowComposer],
  );

  if (!agent) {
    return (
      <AgentPanel
        title="Mail assistant"
        onSubmit={() => undefined}
        onClose={onClose}
        disabled
        emptyHint={<p>The assistant is not available here. Mail still works as usual.</p>}
      />
    );
  }

  const afterDraft = (run: Promise<void>) => {
    void run.then(() => {
      if (agent.getState().items[0]?.kind === "draft" && !agent.getState().error) onShowComposer?.();
    });
  };

  const quick = (
    <div className="mail-agent__quick" role="group" aria-label="Quick actions">
      <button type="button" className="oui-chip" disabled={!hasThread || state.busy} onClick={() => afterDraft(agent.draftReply())}>Draft a reply</button>
      <button type="button" className="oui-chip" disabled={!hasThread || state.busy} onClick={() => void agent.summarize()}>Summarise</button>
      <button type="button" className="oui-chip" disabled={(!selected && !hasThread) || state.busy} onClick={() => void agent.suggestTriage()}>
        {selected > 1 ? `Suggest triage (${selected})` : "Suggest triage"}
      </button>
      <button type="button" className="oui-chip" disabled={state.busy} onClick={() => setBulkOpen(true)}>Bulk drafts…</button>
    </div>
  );

  return (
    <div className="mail-agent">
      {quick}
      {state.error && (
        <div className="mail-agent__error" role="alert">
          <span>{state.error}</span>
          <button type="button" className="oui-button oui-button--ghost" onClick={agent.clearError}>Dismiss</button>
        </div>
      )}
      <AgentPanel
        className="mail-agent__panel"
        title="Mail assistant"
        messages={state.messages}
        statusLines={state.status}
        results={results}
        busy={state.busy}
        onCancel={agent.cancel}
        onClose={onClose}
        onSubmit={(text) => afterDraft(agent.ask(text))}
        placeholder={hasThread ? "Reply, summarise, or ask about your mail…" : "Find a conversation or describe a new email…"}
        suggestions={hasThread
          ? ["Reply yes and ask for the agenda", "Summarise this thread"]
          : ["Find the document they pushed back on last month", "Write to a contact asking for a call next week"]}
        emptyHint={<p>Drafts the assistant writes open in the composer for your review. Nothing is sent without your click.</p>}
      />
      {showBulk && (
        <BulkDraftsDialog
          open
          agent={agent}
          store={store}
          initialRows={bulkRows ?? null}
          onClose={() => {
            setBulkOpen(false);
            onBulkRowsConsumed?.();
          }}
        />
      )}
    </div>
  );
}
