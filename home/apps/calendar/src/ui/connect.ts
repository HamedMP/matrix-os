/**
 * Wires the Calendar store to the Matrix OS bridge: connected accounts become
 * provider adapters, preferences and agent proposals live in the app's tables.
 */
import type { MatrixOSBridge } from "../../../_shared/matrix-os";
import { createCalendarProvider, listCalendarAccounts } from "../../../_shared/office-accounts/calendar";
import { createCalendarStore, createDbPersistence, createMemoryPersistence, PROPOSALS_TABLE, type CalendarStore } from "../model";

type CalendarBridge = Pick<MatrixOSBridge, "service" | "integrations" | "db">;

function currentBridge(): Partial<CalendarBridge> | null {
  const host = globalThis as { MatrixOS?: Partial<CalendarBridge> };
  return host.MatrixOS ?? null;
}

function hasDb(bridge: Partial<CalendarBridge> | null): bridge is Partial<CalendarBridge> & Pick<CalendarBridge, "db"> {
  return Boolean(bridge?.db && typeof bridge.db.find === "function" && typeof bridge.db.insert === "function");
}

/** The store the app runs on. Without a bridge (a plain browser tab) accounts fail with a generic message. */
export function createAppStore(): CalendarStore {
  const bridge = currentBridge();
  return createCalendarStore({
    connect: async () => {
      const accounts = await listCalendarAccounts();
      return accounts.map((connected) => ({ account: connected.account, provider: createCalendarProvider(connected) }));
    },
    persistence: hasDb(bridge) ? createDbPersistence(bridge.db) : createMemoryPersistence(),
  });
}

const started = new WeakSet<CalendarStore>();

/**
 * Loads the store once (React may run effects twice in development) and
 * reloads agent proposals whenever the agent writes the proposals table.
 * Returns the unsubscribe for the table watch.
 */
export function startAppStore(store: CalendarStore): () => void {
  if (!started.has(store)) {
    started.add(store);
    void store.init();
  }
  const bridge = currentBridge();
  if (!hasDb(bridge) || typeof bridge.db.onChange !== "function") return () => undefined;
  return bridge.db.onChange(PROPOSALS_TABLE, () => {
    void store.loadAgentProposals();
  });
}
