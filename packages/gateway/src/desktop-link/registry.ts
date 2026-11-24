// Live desktop links and the Herdr adapter that reaches each desktop (spec 2716).
// One link per device: a newer admitted link replaces the older. Each device
// keeps one adapter, which opens core streams over whichever link is current,
// so viewers re-attach after a reconnect without the adapter being rebuilt.
import { HerdrTransportError } from "@matrix-os/herdr-core-client/session-host";
import { DESKTOP_LINK_CLOSE, DESKTOP_LINK_MAX_DEVICES } from "@matrix-os/contracts/desktop-link";
import { createHerdrAdapter, type HerdrAdapter } from "../herdr/adapter.js";
import type { DesktopLink } from "./link.js";

export const DESKTOP_LINK_PING_MS = 15_000;
export const DESKTOP_LINK_STALE_MS = 45_000;

export interface DesktopLinkRegistryOptions {
  now?: () => number;
  /** Builds the adapter for one device; replaced in tests. */
  createAdapter?: (open: () => Promise<import("@matrix-os/herdr-core-client/client").HcSocket>) => HerdrAdapter;
  /** Called (best effort) when a link is admitted and on each sweep while it is alive. */
  seen?: (deviceId: string) => void;
  pingMs?: number;
  staleMs?: number;
  maxLinks?: number;
}

export function createDesktopLinkRegistry(options: DesktopLinkRegistryOptions = {}) {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DESKTOP_LINK_STALE_MS;
  const maxLinks = options.maxLinks ?? DESKTOP_LINK_MAX_DEVICES;
  const createAdapter = options.createAdapter ?? ((open) => createHerdrAdapter({ open }));
  // Both bounded by maxLinks: a device has an adapter only while it has a link
  // or was linked since start, and devices are capped at DESKTOP_LINK_MAX_DEVICES.
  const links = new Map<string, DesktopLink>();
  const adapters = new Map<string, HerdrAdapter>();
  let draining = false;

  function adapterFor(deviceId: string): HerdrAdapter {
    let adapter = adapters.get(deviceId);
    if (!adapter) {
      adapter = createAdapter(() => {
        const link = links.get(deviceId);
        return link && !link.closed ? link.openStream() : Promise.reject(new HerdrTransportError("unavailable"));
      });
      adapters.set(deviceId, adapter);
    }
    return adapter;
  }

  function sweep(): void {
    const at = now();
    for (const [deviceId, link] of links) {
      if (link.closed) { links.delete(deviceId); continue; }
      if (at - link.lastSeen() > staleMs) {
        link.close(DESKTOP_LINK_CLOSE.going);
        links.delete(deviceId);
        continue;
      }
      link.send({ t: "ping" });
      options.seen?.(deviceId);
    }
  }
  const timer = setInterval(sweep, options.pingMs ?? DESKTOP_LINK_PING_MS);
  timer.unref?.();

  return {
    /** Admits a link that passed its proof. False when the registry is full or shutting down. */
    admit(link: DesktopLink): boolean {
      if (draining) return false;
      const { deviceId } = link.info;
      const previous = links.get(deviceId);
      if (!previous) {
        for (const [id, other] of links) if (other.closed) links.delete(id);
        if (links.size >= maxLinks) return false;
      }
      links.set(deviceId, link);
      if (previous && previous !== link) previous.close(DESKTOP_LINK_CLOSE.replaced);
      adapterFor(deviceId);
      options.seen?.(deviceId);
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
    /** The owner removed the device: its link ends now and its adapter is dropped. */
    remove(deviceId: string): void {
      const link = links.get(deviceId);
      links.delete(deviceId);
      if (link) {
        link.send({ t: "bye", reason: "removed" });
        link.close(DESKTOP_LINK_CLOSE.removed);
      }
      const adapter = adapters.get(deviceId);
      adapters.delete(deviceId);
      adapter?.close();
    },
    size: () => links.size,
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
