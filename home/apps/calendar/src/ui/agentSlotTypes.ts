/**
 * The props the agent slot passes to `ui/agent` (`CalendarAgentPanel`, a
 * named export of `ui/agent/index.ts`). Declared here as the subset the slot
 * uses, so the app still builds when that module is absent.
 */
import type { CalendarStore } from "../model";

/** A time chip the owner clicked in the agent panel. */
export type AgentHighlight =
  | { type: "event"; id: string; start: string; end: string }
  | { type: "slot"; id: string; start: string; end: string };

export interface AgentSlotPanelProps {
  store: CalendarStore;
  onHighlight?: (target: AgentHighlight) => void;
  onClose?: () => void;
  now?: () => number;
}
