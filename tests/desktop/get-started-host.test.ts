import { describe, expect, it, vi } from "vitest";
import { createDesktopGetStartedPort } from "../../desktop/src/renderer/src/features/get-started/desktop-get-started-port.js";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api.js";

describe("Electron Get started port", () => {
  it("binds load and save to the runtime the wizard started on", async () => {
    const bound = {
      get: vi.fn(async () => ({ status: "pending" })),
      put: vi.fn(async () => ({ status: "skipped", skippedAt: "2026-10-25T10:12:00.000Z" })),
    };
    const api = { forRuntime: vi.fn(() => bound), get: vi.fn(), put: vi.fn() } as unknown as ApiClient;
    const port = createDesktopGetStartedPort(api, "pv-2848-55c2d72e");
    expect(api.forRuntime).toHaveBeenCalledWith("pv-2848-55c2d72e");
    const signal = new AbortController().signal;
    await expect(port.load(signal)).resolves.toEqual({ status: "pending" });
    expect(bound.get).toHaveBeenCalledWith("/api/settings/get-started", expect.objectContaining({ cache: "no-store", signal, timeoutMs: 10_000 }));
    await port.save({ type: "skip" });
    expect(bound.put).toHaveBeenCalledWith("/api/settings/get-started", { type: "skip" }, expect.objectContaining({ timeoutMs: 10_000 }));
    expect(api.get).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });
});
