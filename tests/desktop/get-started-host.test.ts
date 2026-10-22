import { describe, expect, it, vi } from "vitest";
import { createDesktopGetStartedPort } from "../../desktop/src/renderer/src/features/get-started/desktop-get-started-port.js";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api.js";

describe("Electron Get started port", () => {
  it("uses the bounded API client for load and save", async () => {
    const api = {
      get: vi.fn(async () => ({ status: "pending" })),
      put: vi.fn(async () => ({ status: "skipped", skippedAt: "2026-10-25T10:12:00.000Z" })),
    } as unknown as ApiClient;
    const port = createDesktopGetStartedPort(api);
    const signal = new AbortController().signal;
    await expect(port.load(signal)).resolves.toEqual({ status: "pending" });
    expect(api.get).toHaveBeenCalledWith("/api/settings/get-started", expect.objectContaining({ cache: "no-store", signal, timeoutMs: 10_000 }));
    await port.save({ type: "skip" });
    expect(api.put).toHaveBeenCalledWith("/api/settings/get-started", { type: "skip" }, expect.objectContaining({ timeoutMs: 10_000 }));
  });
});
