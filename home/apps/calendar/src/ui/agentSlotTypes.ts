/**
 * Contract for `ui/agent/CalendarAgentPanel.tsx` (default export). The panel
 * gets the live store and state; it may call `receiveProposals`,
 * `openDraftFromProposal` and draft actions, but must leave sending to the
 * owner's explicit Send invite click.
 */
import type { CalendarState, CalendarStore } from "../model";

export interface CalendarAgentPanelProps {
  store: CalendarStore;
  state: CalendarState;
  onClose(): void;
}
