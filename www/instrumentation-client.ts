export {};

import { initializeWwwPostHog } from "./src/lib/posthog-client";

type MatrixIdleDeadline = { didTimeout: boolean; timeRemaining(): number };
type IdleCallbackHandle = ReturnType<typeof setTimeout>;
type IdleWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (callback: (deadline: MatrixIdleDeadline) => void, options?: { timeout: number }) => IdleCallbackHandle;
  };

function initializePostHogWhenIdle() {
  const idleWindow = window as IdleWindow;
  const initialize = () => initializeWwwPostHog(document.documentElement.dataset.posthogVisitorCountry);

  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(initialize, { timeout: 3000 });
    return;
  }

  if (document.readyState === "complete") {
    setTimeout(initialize, 0);
    return;
  }

  window.addEventListener("load", initialize, { once: true });
}

initializePostHogWhenIdle();
