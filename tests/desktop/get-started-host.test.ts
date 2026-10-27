import { describe, expect, it, vi } from "vitest";
import { createDesktopGetStartedGalleryPort, createDesktopGetStartedPort } from "../../desktop/src/renderer/src/features/get-started/desktop-get-started-port.js";
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

  it("asks the wizard's runtime for bot name suggestions", async () => {
    const bound = { get: vi.fn(), put: vi.fn(), post: vi.fn(async () => ({ names: [] })) };
    const api = { forRuntime: vi.fn(() => bound) } as unknown as ApiClient;
    const port = createDesktopGetStartedPort(api, "vm-2");
    const request = { goals: ["code" as const], personality: "calm-mentor" as const, exclude: [] };
    const signal = new AbortController().signal;
    await expect(port.suggestBotNames!(request, signal)).resolves.toEqual({ names: [] });
    expect(bound.post).toHaveBeenCalledWith("/api/settings/get-started/bot-names", request, expect.objectContaining({ signal, timeoutMs: 12_000, omitErrorBody: true }));
  });
});

describe("Electron Get started gallery port", () => {
  it("lists and installs on the wizard's runtime and uses the runtime's gallery icon", async () => {
    const bound = {
      get: vi.fn(async () => ({ version: 1, apps: [] })),
      post: vi.fn(async () => ({ status: "installed" })),
    };
    const api = { forRuntime: vi.fn(() => bound) } as unknown as ApiClient;
    const gallery = createDesktopGetStartedGalleryPort(api, "studio", "https://app.matrix-os.com");
    const signal = new AbortController().signal;
    await gallery.list(signal);
    expect(bound.get).toHaveBeenCalledWith("/api/app-gallery", expect.objectContaining({ signal, timeoutMs: 10_000 }));
    await gallery.install("folio");
    expect(bound.post).toHaveBeenCalledWith("/api/app-gallery/folio/install", {}, expect.objectContaining({ timeoutMs: 10_000 }));
    expect(gallery.iconUrl("folio")).toBe("https://app.matrix-os.com/icons/gallery-folio.png?runtime=studio");
    await expect(gallery.install("../etc")).rejects.toThrow();
  });
});
