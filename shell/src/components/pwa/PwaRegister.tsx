"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker. The worker owns only public shell/offline
 * assets; runtime VM documents bypass it so hashed VPS shell chunks cannot be
 * pinned to stale HTML after a preview or host-bundle rollout.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const register = async () => {
      try {
        await navigator.serviceWorker.register("/service-worker.js", {
          scope: "/",
          updateViaCache: "none",
        });
      } catch (err) {
        console.warn("[pwa] service worker registration failed:", err instanceof Error ? err.message : err);
      }
    };

    void register();
  }, []);

  return null;
}
