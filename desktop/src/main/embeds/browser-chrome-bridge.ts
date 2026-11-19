// Browser and Cloud desktop embeds publish their status and actions to the
// host window title bar. The embed sends a strict, enum-only model; main maps
// its sender to the embed id and the renderer draws host-owned controls.
import { BrowserChromeModelSchema, parseBrowserChromeAction, type BrowserChromeModel } from "@matrix-os/contracts";
import { BROWSER_CHROME_ACTION_CHANNEL } from "../../shared/browser-chrome";
import { MAX_TOTAL_EMBEDS } from "./embed-manager";

export { BROWSER_CHROME_ACTION_CHANNEL, BROWSER_CHROME_PUBLISH_CHANNEL } from "../../shared/browser-chrome";

interface ChromeContents { id: number; send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean }

export function createBrowserChromeBridge(deps: { emit(embedId: string, model: BrowserChromeModel | null): void }) {
  // Insertion-ordered so the oldest registration is evicted at the embed cap.
  const views = new Map<number, { embedId: string; contents: ChromeContents }>();
  const byEmbed = (embedId: string) => {
    for (const entry of views.values()) if (entry.embedId === embedId) return entry;
    return undefined;
  };
  return {
    register(contents: ChromeContents, embedId: string): () => void {
      const previous = views.get(contents.id);
      if (previous && previous.embedId !== embedId) deps.emit(previous.embedId, null);
      views.delete(contents.id);
      while (views.size >= MAX_TOTAL_EMBEDS) {
        const oldest = views.keys().next().value as number;
        deps.emit(views.get(oldest)!.embedId, null);
        views.delete(oldest);
      }
      const entry = { embedId, contents };
      views.set(contents.id, entry);
      return () => {
        if (views.get(contents.id) !== entry) return;
        views.delete(contents.id);
        deps.emit(embedId, null);
      };
    },
    publish(senderId: number, raw: unknown): void {
      const entry = views.get(senderId);
      if (!entry || entry.contents.isDestroyed()) return;
      if (raw === null) { deps.emit(entry.embedId, null); return; }
      const parsed = BrowserChromeModelSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[browser-chrome] Dropped invalid title bar model");
        return;
      }
      deps.emit(entry.embedId, parsed.data);
    },
    dispatch(embedId: string, raw: unknown): boolean {
      const action = parseBrowserChromeAction(raw);
      const entry = byEmbed(embedId);
      if (!action || !entry || entry.contents.isDestroyed()) return false;
      try {
        entry.contents.send(BROWSER_CHROME_ACTION_CHANNEL, action);
        return true;
      } catch (error: unknown) {
        console.warn("[browser-chrome] Action delivery failed", error instanceof Error ? error.name : "unknown");
        return false;
      }
    },
    size: () => views.size,
  };
}
export type BrowserChromeBridge = ReturnType<typeof createBrowserChromeBridge>;
