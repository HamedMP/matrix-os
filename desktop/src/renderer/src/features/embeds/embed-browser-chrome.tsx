import { useEffect, useState } from "react";
import type { BrowserChromeAction, BrowserChromeModel } from "@matrix-os/contracts";
import { BrowserTitleBarControls } from "@matrix-os/ui";
import { invoke, onEvent } from "../../lib/operator";

const MAX_TRACKED_EMBEDS = 12;

/**
 * Latest title bar model published by Browser embeds. A model can arrive
 * before `embed:open` resolves, so a small bounded record holds early events.
 */
export function useEmbedBrowserChrome(enabled: boolean, embedId: string | null): BrowserChromeModel | null {
  const [models, setModels] = useState<Record<string, BrowserChromeModel | null>>({});
  useEffect(() => {
    if (!enabled) return;
    return onEvent("embed:browser-chrome", (payload) => {
      setModels((previous) => {
        const next = { ...previous };
        delete next[payload.embedId];
        next[payload.embedId] = payload.model;
        const ids = Object.keys(next);
        for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_EMBEDS))) delete next[stale];
        return next;
      });
    });
  }, [enabled]);
  return enabled && embedId ? models[embedId] ?? null : null;
}

export function EmbedBrowserTitleBarControls({ embedId, model }: { embedId: string; model: BrowserChromeModel }) {
  const onAction = (action: BrowserChromeAction) => {
    void invoke("embed:browser-chrome-action", { embedId, action }).catch((error: unknown) => {
      console.warn("[browser-chrome] Title bar action failed", error instanceof Error ? error.name : "unknown");
    });
  };
  return <BrowserTitleBarControls model={model} onAction={onAction} />;
}
