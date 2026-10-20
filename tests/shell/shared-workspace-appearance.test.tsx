// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const { patch, config } = vi.hoisted(() => ({ patch: vi.fn().mockResolvedValue(undefined), config: { background: { type: "wallpaper", name: "matrix-dusk.webp" } } }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => ({}) }));
vi.mock("@/hooks/useDesktopConfig", () => ({
  useDesktopConfig: () => config,
  saveDesktopConfigPatch: patch, buildMeshGradient: () => "", BUNDLED_WALLPAPERS: new Set(["matrix-dusk.webp"]),
  wallpaperUrl: (name: string, gateway: string) => `${gateway}/api/files/blob?path=system/wallpapers/${name}`,
}));
vi.mock("@/stores/desktop-config", () => ({ useDesktopConfigStore: Object.assign((selector: (store: unknown) => unknown) => selector({ dock: { position: "left", size: 56, iconSize: 40 }, setDock: vi.fn() }), { getState: () => ({ dock: {} }) }) }));
vi.mock("@/components/settings/DesignPicker", () => ({ DesignPicker: () => null }));
import { AppearanceSection } from "../../shell/src/components/settings/sections/AppearanceSection";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); patch.mockClear(); window.history.replaceState({}, "", "/"); });

describe("shared preview wallpaper capabilities", () => {
  it("disables unsupported uploads and skips owner wallpaper listing while preserving bundled selection", async () => {
    window.history.replaceState({}, "", "/workspace");
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ wallpapers: ["owner-upload.png"] }) });
    vi.stubGlobal("fetch", fetcher);
    render(<AppearanceSection />);
    expect((screen.getByLabelText("Upload image") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Custom wallpaper uploads and deletion are unavailable in this preview.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete wallpaper/ })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "matrix-dusk.webp" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ background: { type: "wallpaper", name: "matrix-dusk.webp" } }));
  });
  it("preserves personal wallpaper listing, upload and delete controls", async () => {
    window.history.replaceState({}, "", "/vm/primary");
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ wallpapers: ["owner-upload.png"] }) });
    vi.stubGlobal("fetch", fetcher);
    render(<AppearanceSection />);
    expect((screen.getByLabelText("Upload image") as HTMLInputElement).disabled).toBe(false);
    expect(await screen.findByRole("button", { name: "Delete wallpaper owner-upload.png" })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith(`${window.location.origin}/vm/primary/api/settings/wallpapers`, expect.anything());
    expect(screen.queryByText(/Custom wallpaper uploads and deletion/)).toBeNull();
  });
});
