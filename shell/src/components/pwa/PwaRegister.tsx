"use client";

import { useEffect } from "react";

export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/service-worker.js", {
          scope: "/",
          updateViaCache: "none",
        });

        if (reg.waiting) reg.waiting.postMessage("skipWaiting");
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              installing.postMessage("skipWaiting");
            }
          });
        });
      } catch (err) {
        console.warn("[pwa] service worker registration failed:", err instanceof Error ? err.message : err);
      }
    };

    void register();
  }, []);

  return null;
}
