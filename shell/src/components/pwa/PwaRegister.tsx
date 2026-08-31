"use client";

import { useEffect } from "react";

/**
 * Activates an already-installed update and reloads once the new worker owns
 * the page. The immediate reload prevents the running document from mixing
 * application generations after the worker prunes its predecessor's caches.
 */
export function activateWaitingServiceWorker(
  registration: ServiceWorkerRegistration,
  serviceWorkers: ServiceWorkerContainer,
  reload: () => void,
): void {
  if (!registration.waiting) return;
  let reloading = false;
  serviceWorkers.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    reload();
  }, { once: true });
  registration.waiting.postMessage("skipWaiting");
}

export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/service-worker.js", {
          scope: "/",
          updateViaCache: "none",
        });
        let activationRequested = false;
        const activateUpdate = () => {
          if (activationRequested || !navigator.serviceWorker.controller || !registration.waiting) return;
          activationRequested = true;
          activateWaitingServiceWorker(registration, navigator.serviceWorker, () => window.location.reload());
        };

        activateUpdate();
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") activateUpdate();
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
