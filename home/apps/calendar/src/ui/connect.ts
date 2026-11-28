/**
 * Wires the Calendar store to the Matrix OS bridge: connected accounts become
 * provider adapters, preferences and agent proposals live in the app's tables.
 */
import type { MatrixOSBridge } from "../../../_shared/matrix-os";
import { createCalendarProvider, listCalendarAccounts } from "../../../_shared/office-accounts/calendar";
import { ProviderError, type BusyBlock, type IsoInstant } from "../../../_shared/office-accounts/types/calendar";
import {
  createCalendarStore,
  createDbPersistence,
  createMemoryPersistence,
  defaultCalendar,
  PROPOSALS_TABLE,
  readBusyInBatches,
  type CalendarConnection,
  type CalendarStore,
} from "../model";

type CalendarBridge = Pick<MatrixOSBridge, "service" | "integrations" | "db">;

/** Free-busy for people, straight from a connected provider (read only), in batches it accepts. */
export type FreeBusyLookup = (addresses: string[], start: IsoInstant, end: IsoInstant) => Promise<BusyBlock[]>;

export interface CalendarRuntime {
  store: CalendarStore;
  /** Asks the account that owns the default calendar; the agent panel uses it without touching the grid. */
  getFreeBusy: FreeBusyLookup;
}

function currentBridge(): Partial<CalendarBridge> | null {
  const host = globalThis as { MatrixOS?: Partial<CalendarBridge> };
  return host.MatrixOS ?? null;
}

function hasDb(bridge: Partial<CalendarBridge> | null): bridge is Partial<CalendarBridge> & Pick<CalendarBridge, "db"> {
  const db = bridge?.db;
  return Boolean(db && typeof db.find === "function" && typeof db.bulkInsert === "function" && typeof db.compareAndSwap === "function");
}

/** The store and provider lookups the app runs on. Without a bridge (a plain browser tab) accounts fail with a generic message. */
export function createAppRuntime(): CalendarRuntime {
  const bridge = currentBridge();
  let connections: CalendarConnection[] = [];
  const store = createCalendarStore({
    connect: async () => {
      const accounts = await listCalendarAccounts();
      connections = accounts.map((connected) => ({ account: connected.account, provider: createCalendarProvider(connected) }));
      return connections;
    },
    persistence: hasDb(bridge) ? createDbPersistence(bridge.db) : createMemoryPersistence(),
  });

  async function getFreeBusy(addresses: string[], start: IsoInstant, end: IsoInstant): Promise<BusyBlock[]> {
    const accountId = defaultCalendar(store.getSnapshot().calendars)?.accountId;
    const connection = connections.find((item) => item.account.id === accountId) ?? connections[0];
    if (!connection) throw new ProviderError("not_connected");
    return readBusyInBatches(connection.provider, addresses, start, end);
  }

  return { store, getFreeBusy };
}

/** The store alone, for callers that do not need provider lookups. */
export function createAppStore(): CalendarStore {
  return createAppRuntime().store;
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
