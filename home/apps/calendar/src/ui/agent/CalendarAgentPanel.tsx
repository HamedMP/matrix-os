/**
 * The Calendar app's agent side panel.
 *
 *   <CalendarAgentPanel store={store} onHighlight={setHighlight} onClose={...} />
 *
 * Questions go to `runCalendarAgent`; answers show as cards with time chips
 * (click to show that event or slot on the grid) and "Open draft" actions that
 * put the result into the event composer. Suggested times are placed on the
 * grid as agent proposals. Nothing here saves an event or sends an invite:
 * that stays an explicit click in the composer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPanel, type AgentResult, type AgentStatusLine } from "../../../../_shared/office-ui";
import { runCalendarAgent, type CalendarAgentAnswer, type CalendarAgentDeps, type SlotRef } from "../../agent";
import { instantToMs } from "../../../../_shared/office-accounts/types/calendar";
import { dayKeyAt, type CalendarStore, type Proposal } from "../../model";
import { AnswerBody, type CalendarHighlight } from "./AnswerBody";
import {
  agentContext,
  createStoreAgentDeps,
  openAgentDraft,
  openProposalDraft,
  openRescheduleDraft,
  openSlotDraft,
  placeProposals,
} from "./store-bridge";
import "./calendar-agent.css";

import { AGENT_SUGGESTIONS, MAX_AGENT_ENTRIES } from "./panel-config";

export type { CalendarHighlight } from "./AnswerBody";

export interface CalendarAgentPanelProps {
  store: CalendarStore;
  /** One model call; defaults to `MatrixOS.ai.generate`. */
  generate?: (prompt: string) => Promise<string>;
  /** Free-busy from a provider; defaults to the store's provider lookup (`readFreeBusy`). */
  getFreeBusy?: CalendarAgentDeps["getFreeBusy"];
  /** Called when the owner clicks a time chip, so the grid can highlight that event or slot. */
  onHighlight?: (target: CalendarHighlight) => void;
  onClose?: () => void;
  now?: () => number;
  className?: string;
}

interface Entry {
  id: string;
  request: string;
  answer: CalendarAgentAnswer;
  /** Proposals as the store holds them after placing them on the grid. */
  proposals: Proposal[];
}

const TITLES: Record<CalendarAgentAnswer["kind"], string> = {
  agenda: "Your agenda",
  slots: "Free times",
  proposals: "Suggested times",
  draft: "Event draft",
  reschedule: "New times",
  clarify: "Question",
  error: "Something went wrong",
};

const OPEN_FAILED = "Could not open the draft. Try again.";

export function CalendarAgentPanel({ store, generate, getFreeBusy, onHighlight, onClose, now = Date.now, className }: CalendarAgentPanelProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const token = useRef(0);
  const counter = useRef(0);

  // Closing the panel ends the request in flight: it must not move the grid or
  // place proposals after the owner left.
  useEffect(() => {
    const requests = token;
    return () => {
      requests.current += 1;
    };
  }, []);

  const submit = useCallback(async (request: string) => {
    const current = ++token.current;
    setBusy(true);
    setNotice(null);
    try {
      // This request's reads leave the grid alone once it is stopped or the panel closes.
      const deps = createStoreAgentDeps(store, { generate, getFreeBusy, isActive: () => current === token.current });
      const answer = await runCalendarAgent(request, agentContext(store.getSnapshot(), now()), deps);
      if (current !== token.current) return;
      const proposals = answer.kind === "proposals" ? placeProposals(store, answer.proposals) : [];
      counter.current += 1;
      const entry: Entry = { id: `answer-${counter.current}`, request, answer, proposals };
      setEntries((previous) => [...previous, entry].slice(-MAX_AGENT_ENTRIES));
    } finally {
      // A newer request (or Stop) owns the flag once the token has moved on.
      if (current === token.current) setBusy(false);
    }
  }, [generate, getFreeBusy, now, store]);

  const cancel = useCallback(() => {
    token.current += 1;
    setBusy(false);
  }, []);

  const highlight = useCallback((target: CalendarHighlight) => {
    setActiveId(target.id);
    store.goToDate(dayKeyAt(instantToMs(target.start), store.getSnapshot().timeZone));
    onHighlight?.(target);
  }, [onHighlight, store]);

  const opened = useCallback((ok: boolean) => {
    setNotice(ok ? null : store.getSnapshot().mutationError ?? OPEN_FAILED);
  }, [store]);

  const results: AgentResult[] = entries.map((entry) => {
    const { answer } = entry;
    const eventTitle = answer.kind === "reschedule" ? answer.events[0]?.title : undefined;
    return {
      id: entry.id,
      title: eventTitle ? `${TITLES.reschedule} for ${eventTitle}` : TITLES[answer.kind],
      meta: `You asked: ${entry.request}`,
      summary: answer.text,
      status: "proposed",
      body: (
        <AnswerBody
          answer={answer}
          proposals={entry.proposals}
          timeZone={store.getSnapshot().timeZone}
          activeId={activeId}
          actions={{
            highlight,
            openDraft: () => opened(answer.kind === "draft" && openAgentDraft(store, answer.draft)),
            openSlot: (slot: SlotRef) => opened(answer.kind === "reschedule"
              ? openRescheduleDraft(store, answer.eventId, slot)
              : openSlotDraft(store, slot, answer.kind === "slots" ? answer.attendees : [])),
            openProposal: (proposal: Proposal) => opened(openProposalDraft(store, proposal)),
          }}
        />
      ),
    };
  });

  const statusLines: AgentStatusLine[] = [
    ...(busy ? [{ id: "working", text: "Reading your calendar…", state: "running" as const }] : []),
    ...(notice ? [{ id: "notice", text: notice, state: "error" as const }] : []),
  ];

  return (
    <AgentPanel
      className={className}
      title="Calendar assistant"
      onSubmit={(prompt) => void submit(prompt)}
      results={results}
      statusLines={statusLines}
      busy={busy}
      onCancel={cancel}
      onClose={onClose}
      suggestions={AGENT_SUGGESTIONS}
      placeholder="Ask about your schedule or a meeting to set up…"
      maxLength={1000}
      emptyHint={<p>Ask about your agenda or free time, or describe a meeting. Drafts open in the editor; nothing is sent until you send it.</p>}
    />
  );
}
