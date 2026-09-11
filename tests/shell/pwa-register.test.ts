import { describe, expect, it, vi } from "vitest";
import {
  activateWaitingServiceWorker,
  monitorServiceWorkerUpdate,
} from "@/components/pwa/PwaRegister";

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

  it("observes a worker that was already installing when registration resolved", () => {
    const postMessage = vi.fn();
    let stateChange: (() => void) | undefined;
    const installing = {
      state: "installing",
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "statechange") stateChange = listener;
      }),
    } as unknown as ServiceWorker;
    const registrationState = {
      installing,
      waiting: null as ServiceWorker | null,
      addEventListener: vi.fn(),
    };
    const serviceWorkers = {
      controller: {} as ServiceWorker,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerContainer;

    monitorServiceWorkerUpdate(
      registrationState as unknown as ServiceWorkerRegistration,
      serviceWorkers,
      vi.fn(),
    );
    registrationState.waiting = { postMessage } as unknown as ServiceWorker;
    Object.assign(installing, { state: "installed" });
    stateChange?.();

    expect(postMessage).toHaveBeenCalledWith("skipWaiting");
  });
});
