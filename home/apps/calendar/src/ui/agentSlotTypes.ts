/**
 * The props the agent slot passes to `ui/agent` (`CalendarAgentPanel`, a
 * named export of `ui/agent/index.ts`). Declared here as the subset the slot
 * passes, so the app shell does not depend on the panel's own types.
 */
import type { BusyBlock, IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import type { CalendarStore } from "../model";

/** A time chip the owner clicked in the agent panel. */
export type AgentHighlight =
  | { type: "event"; id: string; start: string; end: string }
  | { type: "slot"; id: string; start: string; end: string };

export interface AgentSlotPanelProps {
  store: CalendarStore;
  /** Free-busy from a provider; without it the panel asks the store's provider lookup (`readFreeBusy`). */
  getFreeBusy?: (addresses: string[], start: IsoInstant, end: IsoInstant) => Promise<BusyBlock[]>;
  onHighlight?: (target: AgentHighlight) => void;
  onClose?: () => void;
  now?: () => number;
}
