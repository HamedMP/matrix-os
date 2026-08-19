import { describe, expect, it, vi } from "vitest";
import { createUpdateAwareBeforeQuit } from "@desktop/main/update-quit";

describe("update-aware application quit", () => {
  it("defers the first ready-state quit to the persisted updater install path", async () => {
    let finishInstall: ((installed: boolean) => void) | null = null;
    const install = vi.fn(() => new Promise<boolean>((resolve) => {
      finishInstall = resolve;
    }));
    const quit = vi.fn();
    const handler = createUpdateAwareBeforeQuit({
      status: () => "ready",
      isInstallStarted: () => false,
      install,
      quit,
      reportError: vi.fn(),
    });
    const firstEvent = { preventDefault: vi.fn() };

    handler(firstEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    finishInstall?.(true);
    await Promise.resolve();

    const updaterQuitEvent = { preventDefault: vi.fn() };
    handler(updaterQuitEvent);
    expect(updaterQuitEvent.preventDefault).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
  });
});
