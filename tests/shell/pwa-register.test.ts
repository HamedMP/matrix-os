import { describe, expect, it, vi } from "vitest";
import { activateWaitingServiceWorker } from "@/components/pwa/PwaRegister";

describe("PWA service-worker updates", () => {
  it("activates a waiting worker and reloads once after it takes control", () => {
    const postMessage = vi.fn();
    const reload = vi.fn();
    let controllerChange: (() => void) | undefined;
    const serviceWorkers = {
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "controllerchange") controllerChange = listener;
      }),
    } as unknown as ServiceWorkerContainer;
    const registration = {
      waiting: { postMessage },
    } as unknown as ServiceWorkerRegistration;

    activateWaitingServiceWorker(registration, serviceWorkers, reload);
    expect(postMessage).toHaveBeenCalledWith("skipWaiting");

    controllerChange?.();
    controllerChange?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
