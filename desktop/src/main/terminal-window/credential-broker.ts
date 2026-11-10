// Holds at most one computer-scoped access token per computer in the owner's
// inventory, for the Terminal window only (spec 651 FR-003/FR-005). Tokens are
// minted lazily, live in memory only, and never reach a renderer.
import { RUNTIME_SLOT_PATTERN as SLOT, TERMINAL_WINDOW_MAX_COMPUTERS as MAX_TOKENS } from "../../shared/terminal-window";

const EXPIRY_SKEW_MS = 60_000;
const INVENTORY_TTL_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface BrokerAuth {
  getStatus(): { signedIn: boolean; authGeneration: number; runtimeSlot: string };
  getToken(): string | null;
  issueRuntimeToken(slot: string): Promise<{ accessToken: string; expiresAt: number; handle: string }>;
  listRuntimeComputers(): Promise<{ items: ReadonlyArray<{ runtimeSlot: string }> }>;
}

export interface ComputerCredentialBrokerOptions {
  auth: BrokerAuth;
  now?: () => number;
  random?: () => number;
}

interface Entry { token: string; expiresAt: number }
interface Failure { count: number; retryAt: number }

/**
 * "denied": this session may not reach that computer (signed out, or not in
 * the owner's inventory). "unavailable": it may, but no bearer can be had
 * right now (platform unreachable, mint failed, backing off).
 */
export type ComputerCredential = { token: string } | { token: null; reason: "denied" | "unavailable" };
const DENIED: ComputerCredential = { token: null, reason: "denied" };
const UNAVAILABLE: ComputerCredential = { token: null, reason: "unavailable" };

export type ComputerCredentialBroker = ReturnType<typeof createComputerCredentialBroker>;

export function createComputerCredentialBroker(options: ComputerCredentialBrokerOptions) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  // All three maps are keyed by inventory slot and cleared together; the
  // inventory itself is capped at 20 computers by the platform contract.
  const tokens = new Map<string, Entry>();
  const pending = new Map<string, Promise<string | null>>();
  const failures = new Map<string, Failure>();
  // A fresh token that was refused once; a second refusal means reconnect.
  const strikes = new Set<string>();
  let generation = -1;
  let inventory: { slots: Set<string>; fetchedAt: number } | null = null;
  let inventoryPending: Promise<Set<string> | null> | null = null;

  function clear(): void {
    tokens.clear();
    pending.clear();
    failures.clear();
    strikes.clear();
    inventory = null;
    inventoryPending = null;
  }

  function syncSession(): { signedIn: boolean; runtimeSlot: string } {
    const status = options.auth.getStatus();
    if (status.authGeneration !== generation) {
      clear();
      generation = status.authGeneration;
    }
    return status;
  }

  function fail(slot: string): void {
    const count = (failures.get(slot)?.count ?? 0) + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (count - 1));
    failures.set(slot, { count, retryAt: now() + delay * (0.5 + random() * 0.5) });
  }

  async function loadInventory(): Promise<Set<string> | null> {
    if (inventory && now() - inventory.fetchedAt < INVENTORY_TTL_MS) return inventory.slots;
    const startedIn = generation;
    inventoryPending ??= options.auth.listRuntimeComputers()
      .then((list) => {
        if (startedIn !== generation) return null;
        const slots = new Set(list.items.slice(0, MAX_TOKENS).map((item) => item.runtimeSlot));
        inventory = { slots, fetchedAt: now() };
        return slots;
      })
      .catch((error: unknown) => {
        console.warn("[terminal-window] inventory unavailable:", error instanceof Error ? error.name : "UnknownError");
        return null;
      })
      .finally(() => { inventoryPending = null; });
    return inventoryPending;
  }

  function mint(slot: string): Promise<string | null> {
    const startedIn = generation;
    const request = options.auth.issueRuntimeToken(slot)
      .then((issued) => {
        // A mint that outlives its session is discarded, never stored.
        if (startedIn !== generation || options.auth.getStatus().authGeneration !== startedIn) return null;
        if (tokens.size >= MAX_TOKENS && !tokens.has(slot)) {
          const oldest = tokens.keys().next().value;
          if (oldest !== undefined) tokens.delete(oldest);
        }
        tokens.set(slot, { token: issued.accessToken, expiresAt: issued.expiresAt });
        failures.delete(slot);
        return issued.accessToken;
      })
      .catch((error: unknown) => {
        console.warn("[terminal-window] computer credential unavailable:", error instanceof Error ? error.name : "UnknownError");
        if (startedIn === generation) fail(slot);
        return null;
      })
      .finally(() => { if (pending.get(slot) === request) pending.delete(slot); });
    pending.set(slot, request);
    return request;
  }

  /** The bearer for one of the owner's computers, or why there is none (fail closed). */
  async function credential(slot: string): Promise<ComputerCredential> {
    if (!SLOT.test(slot)) return DENIED;
    if (!syncSession().signedIn) return DENIED;
    const slots = await loadInventory();
    // Read again after the wait: the app may have signed out or selected
    // another computer meanwhile, and the app's own bearer follows that
    // selection. Comparing against an older selection would attach the newly
    // selected computer's bearer to a request for the previous one.
    const status = syncSession();
    if (!status.signedIn) return DENIED;
    if (!slots) return UNAVAILABLE;
    if (!slots.has(slot)) return DENIED;
    const found = (token: string | null): ComputerCredential => (token ? { token } : UNAVAILABLE);
    if (slot === status.runtimeSlot) return found(options.auth.getToken());
    const cached = tokens.get(slot);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now()) return { token: cached.token };
    tokens.delete(slot);
    const failure = failures.get(slot);
    if (failure && failure.retryAt > now()) return UNAVAILABLE;
    return found(await (pending.get(slot) ?? mint(slot)));
  }

  return {
    credential,

    async token(slot: string): Promise<string | null> {
      return (await credential(slot)).token;
    },

    /** A gateway answered 401 for this token: drop it; a second refusal backs off. */
    unauthorized(slot: string, token: string): void {
      if (tokens.get(slot)?.token !== token) return;
      tokens.delete(slot);
      if (strikes.has(slot)) fail(slot);
      else strikes.add(slot);
    },

    /** A gateway accepted this computer's token. */
    confirmed(slot: string): void {
      strikes.delete(slot);
    },

    clear,
    size: (): number => tokens.size,
  };
}
