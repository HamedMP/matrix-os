"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker. New SW versions are *not* activated
 * mid-session: forcing `skipWaiting` while the page is open lets the new SW
 * `clients.claim()` and prune old caches, breaking static chunk lookups for
 * code the running page still needs. Instead, an installed-and-waiting SW
 * stays in `waiting` state and activates on the next full page load, which
 * is the standard safe pattern.
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
