import { GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS, GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS } from "./google-calendar-scheduling.js";
import type { ServiceAction } from "./types.js";

type ActionsByService = Record<string, Record<string, ServiceAction>>;

/**
 * Merge per-module maps by service. A repeated action id or an action whose
 * risk differs from the map's declared risk is a wiring error: fail at load
 * rather than silently publishing a write without the approval gate.
 */
function byService(risk: "read" | "write", maps: ActionsByService[]): ActionsByService {
  const merged: ActionsByService = {};
  for (const map of maps) {
    for (const [serviceId, actions] of Object.entries(map)) {
      const target = (merged[serviceId] ??= {});
      for (const [actionId, action] of Object.entries(actions)) {
        if (Object.hasOwn(target, actionId)) throw new Error(`Duplicate office action ${serviceId}/${actionId}`);
        if (action.risk !== risk) throw new Error(`Office action ${serviceId}/${actionId} must be ${risk}`);
        target[actionId] = action;
      }
    }
  }
  return merged;
}

/** Calendar writes; merged by `integrationWriteActions`, all listed in `MANAGED_WRITE_ACTIONS`. */
export const OFFICE_WRITE_ACTIONS: ActionsByService = byService("write", [
  GOOGLE_CALENDAR_SCHEDULING_WRITE_ACTIONS,
]);

/** Calendar reads, keyed by the service they extend. */
export const OFFICE_READ_ACTIONS: ActionsByService = byService("read", [{
  google_calendar: GOOGLE_CALENDAR_SCHEDULING_READ_ACTIONS,
}]);

export function officeReadActions(serviceId: string): Record<string, ServiceAction> {
  return OFFICE_READ_ACTIONS[serviceId] ?? {};
}
