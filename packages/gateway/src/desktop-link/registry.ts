// Live desktop links and the Herdr adapter that reaches each desktop (spec 2716).
// One link per device: a newer admitted link replaces the older. Each device
// keeps one adapter, which opens core streams over whichever link is current,
// so viewers re-attach after a reconnect without the adapter being rebuilt.
import { HerdrTransportError } from "@matrix-os/herdr-core-client/session-host";
import {
  DESKTOP_LINK_CALL_TIMEOUT_MS, DESKTOP_LINK_CLOSE, DESKTOP_LINK_MAX_DEVICES, type DesktopLinkDeviceInfo,
} from "@matrix-os/contracts/desktop-link";
import { createHerdrAdapter, type HerdrAdapter } from "../herdr/adapter.js";
import { DesktopCaptureError, type DesktopLink } from "./link.js";

export const DESKTOP_LINK_PING_MS = 15_000;
export const DESKTOP_LINK_STALE_MS = 45_000;
/** Heartbeats between re-reads of the pairing for live links (about once a minute). */
const PAIRING_CHECK_SWEEPS = 4;
const MAX_RUNS_PER_MINUTE = 10;
const MAX_CAPTURES_PER_MINUTE = 6;

export interface DesktopLinkRegistryOptions {
  now?: () => number;
  /** Builds the adapter for one device; replaced in tests. */
  createAdapter?: (open: () => Promise<import("@matrix-os/herdr-core-client/client").HcSocket>) => HerdrAdapter;
  /**
   * The current 2698 pairing, read before each new core stream and screenshot,
   * so a link whose pairing changed is refused even if the change notice was missed.
   */
  pairing?: () => Promise<{ deviceId: string | null; revision: number }>;
  /** Called when a link is admitted and on each heartbeat while it is alive; the caller throttles writes. */
  seen?: (link: DesktopLink) => void;
  pingMs?: number;
  staleMs?: number;
  maxLinks?: number;
}

export function createDesktopLinkRegistry(options: DesktopLinkRegistryOptions = {}) {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DESKTOP_LINK_STALE_MS;
  const maxLinks = options.maxLinks ?? DESKTOP_LINK_MAX_DEVICES;
  const createAdapter = options.createAdapter ?? ((open) => createHerdrAdapter({ open, callTimeoutMs: DESKTOP_LINK_CALL_TIMEOUT_MS }));
  // Both bounded by maxLinks: a device keeps an adapter while it is linked, or
  // offline but still the one paired; another device linking, or a pairing
  // change, closes the adapters of every device that is neither.
  const links = new Map<string, DesktopLink>();
  const adapters = new Map<string, HerdrAdapter>();
  let draining = false;
  // Start times per device, for allowRun. Bounded to twice the link cap, oldest first out.
  const runs = new Map<string, number[]>();
  const captures = new Map<string, number[]>();
  // Set by the routes (the registry is built before the owner database is known).
  let pairing = options.pairing;
  let seen = options.seen;
  function heard(link: DesktopLink): void {
    try {
      seen?.(link);
    } catch (error: unknown) {
      console.warn("[desktop-link] last-seen notice failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  /** Ends a link whose pairing changed: the desktop is told it was removed. */
  function revoke(deviceId: string): void {
    const link = links.get(deviceId);
    links.delete(deviceId);
    if (link) {
      link.send({ t: "bye", reason: "removed" });
      link.close(DESKTOP_LINK_CLOSE.removed);
    }
    const adapter = adapters.get(deviceId);
    adapters.delete(deviceId);
    adapter?.close();
  }

  /** The link for a device, if it is still live and its pairing still current. */
  async function current(deviceId: string): Promise<DesktopLink | null> {
    const link = links.get(deviceId);
    if (!link || link.closed) return null;
    if (!pairing) return link;
    const state = await pairing();
    if (state.deviceId !== deviceId || state.revision !== link.info.revision) {
      if (links.get(deviceId) === link) revoke(deviceId);
      return null;
    }
    return links.get(deviceId) === link && !link.closed ? link : null;
  }

  /** Closes the adapters of devices that are not linked now, except `keep`. */
  function pruneAdapters(keep: string | null): void {
    for (const [deviceId, adapter] of [...adapters]) {
      if (deviceId === keep || links.has(deviceId)) continue;
      adapters.delete(deviceId);
      adapter.close();
    }
  }

  function adapterFor(deviceId: string): HerdrAdapter {
    let adapter = adapters.get(deviceId);
    if (!adapter) {
      adapter = createAdapter(async () => {
        const link = await current(deviceId);
        if (!link) throw new HerdrTransportError("unavailable");
        return link.openStream();
      });
      adapters.set(deviceId, adapter);
    }
    return adapter;
  }

  // The newest pairing state this registry was told about: a link admitted at an
  // older revision (its proof was checked just before a change committed) is refused.
  let latest: { deviceId: string | null; revision: number } | null = null;
  // Sweeps since the pairing was last re-read for live links (every PAIRING_CHECK_SWEEPS).
  let sweepsSinceCheck = 0;

  function sweep(): void {
    const at = now();
    // A missed change notice (another gateway process, a direct database change)
    // still ends a live link within a few heartbeats.
    sweepsSinceCheck += 1;
    if (pairing && sweepsSinceCheck >= PAIRING_CHECK_SWEEPS) {
      sweepsSinceCheck = 0;
      for (const deviceId of links.keys()) {
        current(deviceId).catch((error: unknown) => {
          console.warn("[desktop-link] pairing check failed:", error instanceof Error ? error.name : "UnknownError");
        });
      }
    }
    for (const [deviceId, link] of links) {
      if (link.closed) { links.delete(deviceId); continue; }
      if (at - link.lastSeen() > staleMs) {
        link.close(DESKTOP_LINK_CLOSE.going);
        links.delete(deviceId);
        continue;
      }
      link.send({ t: "ping" });
      heard(link);
    }
  }
  const timer = setInterval(sweep, options.pingMs ?? DESKTOP_LINK_PING_MS);
  timer.unref?.();

  return {
    /** Admits a link that passed its proof. False when the registry is full or shutting down. */
    admit(link: DesktopLink): boolean {
      if (draining) return false;
      const { deviceId } = link.info;
      if (latest && (latest.revision > link.info.revision || (latest.revision === link.info.revision && latest.deviceId !== deviceId))) {
        return false;
      }
      const previous = links.get(deviceId);
      if (!previous) {
        for (const [id, other] of links) if (other.closed) links.delete(id);
        if (links.size >= maxLinks) return false;
      }
      links.set(deviceId, link);
      if (previous && previous !== link) previous.close(DESKTOP_LINK_CLOSE.replaced);
      pruneAdapters(deviceId);
      adapterFor(deviceId);
      heard(link);
      return true;
    },
    /** The link's WebSocket closed. Only forgets it if it is still the current link. */
    closed(link: DesktopLink): void {
      link.closedBy(DESKTOP_LINK_CLOSE.going);
      if (links.get(link.info.deviceId) === link) links.delete(link.info.deviceId);
    },
    /** The one linked device whose id starts with `prefix`, or null when none or several do. */
    deviceByPrefix(prefix: string): string | null {
      const matches = [...links.keys()].filter((deviceId) => deviceId.startsWith(prefix));
      return matches.length === 1 ? matches[0]! : null;
    },
    online(deviceId: string): boolean {
      const link = links.get(deviceId);
      return link !== undefined && !link.closed;
    },
    /** The adapter for a device that is linked now, or null. */
    adapter(deviceId: string): HerdrAdapter | null {
      return this.online(deviceId) ? adapterFor(deviceId) : null;
    },
    /**
     * The 2698 pairing changed (pair, re-pair or disconnect committed): every
     * link not admitted under exactly this device and revision ends now.
     */
    pairingChanged(state: { deviceId: string | null; revision: number }): void {
      if (!latest || state.revision >= latest.revision) latest = { deviceId: state.deviceId, revision: state.revision };
      for (const [deviceId, link] of [...links]) {
        if (deviceId !== state.deviceId || link.info.revision !== state.revision) revoke(deviceId);
      }
      // An offline device that is no longer the paired one keeps nothing either.
      pruneAdapters(state.deviceId);
    },
    /** Where admitted and live links are reported (the throttled last-seen write). */
    observeSeen(listener: (link: DesktopLink) => void): void { seen = listener; },
    size: () => links.size,
    /** True once shutdown began: new links are refused. */
    draining: () => draining,
    /** Where the current pairing is read from (2698's owner table). */
    usePairing(read: () => Promise<{ deviceId: string | null; revision: number }>): void { pairing = read; },
    /**
     * One more terminal started on this device by the computer: at most 10 a
     * minute per desktop, shared by the routes and the kernel.
     */
    allowRun(deviceId: string): boolean {
      const at = now();
      const recent = (runs.get(deviceId) ?? []).filter((time) => at - time < 60_000);
      if (recent.length >= MAX_RUNS_PER_MINUTE) { runs.set(deviceId, recent); return false; }
      recent.push(at);
      runs.delete(deviceId);
      runs.set(deviceId, recent);
      while (runs.size > maxLinks * 2) {
        const oldest = runs.keys().next().value;
        if (oldest === undefined) break;
        runs.delete(oldest);
      }
      return true;
    },
    /** One screenshot of a linked desktop's screen, at most 6 a minute per desktop. */
    async capture(deviceId: string): Promise<Buffer> {
      const link = await current(deviceId);
      if (!link) throw new DesktopCaptureError("offline");
      const at = now();
      const recent = (captures.get(deviceId) ?? []).filter((time) => at - time < 60_000);
      if (recent.length >= MAX_CAPTURES_PER_MINUTE) throw new DesktopCaptureError("busy");
      recent.push(at);
      captures.delete(deviceId);
      captures.set(deviceId, recent);
      while (captures.size > maxLinks * 2) {
        const oldest = captures.keys().next().value;
        if (oldest === undefined) break;
        captures.delete(oldest);
      }
      return link.capture();
    },
    /** Where the current pairing is read from (2698's owner table). */
    usePairing(read: () => Promise<{ deviceId: string | null; revision: number }>): void { pairing = read; },
    /** Every linked device's id, name and adapter, for terminal verbs and the kernel. */
    linked(): Array<{ deviceId: string; name: string; device: DesktopLinkDeviceInfo; adapter: HerdrAdapter }> {
      return [...links.values()].filter((link) => !link.closed).map((link) => ({
        deviceId: link.info.deviceId, name: link.info.name, device: link.info.device, adapter: adapterFor(link.info.deviceId),
      }));
    },
    sweep,
    /** Shutdown: tells each desktop, closes links, then adapters. */
    async drain(): Promise<void> {
      draining = true;
      clearInterval(timer);
      for (const link of links.values()) {
        link.send({ t: "bye", reason: "shutdown" });
        link.close(DESKTOP_LINK_CLOSE.going);
      }
      links.clear();
      const open = [...adapters.values()];
      adapters.clear();
      await Promise.all(open.map(async (adapter) => adapter.close()));
    },
  };
}

export type DesktopLinkRegistry = ReturnType<typeof createDesktopLinkRegistry>;
