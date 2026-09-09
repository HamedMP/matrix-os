// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeCompatibility, RUNTIME_RECONNECTED_EVENT } from "@renderer/lib/runtime-compatibility";
import RuntimeCompatibilityGate from "@renderer/features/updates/RuntimeCompatibilityGate";
import { useConnection } from "@renderer/stores/connection";
import { useUi } from "@renderer/stores/ui";
import type { ApiClient } from "@renderer/lib/api";

const info = { version: "v2026.09.09-1", runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 1, maxDesktopProtocol: 1 } };
const future = { ...info, runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 3 } };
function client(get: ReturnType<typeof vi.fn>): ApiClient { return { get, forRuntime() { return this; } } as unknown as ApiClient; }
beforeEach(() => {
  vi.stubGlobal("operator", { invoke: vi.fn(async () => ({ ok: true })) });
  useUi.setState({ rendererOverlayCount: 0 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("runtime compatibility lifecycle", () => {
  it("checks again on an established realtime connection", async () => {
    const get = vi.fn().mockResolvedValueOnce(info).mockResolvedValue(future);
    const api = client(get);
    const { result } = renderHook(() => useRuntimeCompatibility(api));
    await waitFor(() => expect(result.current.status).toBe("compatible"));
    act(() => window.dispatchEvent(new Event(RUNTIME_RECONNECTED_EVENT)));
    await waitFor(() => expect(result.current.status).toBe("desktop-update-required"));
    expect(get).toHaveBeenCalledWith("/api/system/info", expect.objectContaining({ maxBytes: 65536, timeoutMs: 10000, signal: expect.any(AbortSignal) }));
  });
  it("aborts and fences an old computer's response after switching", async () => {
    let resolveOld!: (value: unknown) => void;
    const getOld = vi.fn(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { result, rerender } = renderHook(({ api }) => useRuntimeCompatibility(api), { initialProps: { api: client(getOld) } });
    const oldSignal = getOld.mock.calls[0]![1].signal as AbortSignal;
    rerender({ api: client(vi.fn().mockResolvedValue(info)) });
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.status).toBe("compatible"));
    await act(async () => resolveOld(future));
    expect(result.current.status).toBe("compatible");
  });
  it("preserves a mounted draft through incompatibility and recovery", async () => {
    const get = vi.fn().mockResolvedValue(info);
    useConnection.setState({ api: client(get) });
    function Workspace() {
      const [value, setValue] = useState("");
      return <input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    render(<RuntimeCompatibilityGate><Workspace /></RuntimeCompatibilityGate>);
    const draft = await screen.findByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "keep my draft" } });
    get.mockResolvedValue(future);
    act(() => window.dispatchEvent(new Event(RUNTIME_RECONNECTED_EVENT)));
    await screen.findByRole("dialog", { name: "Update Matrix OS" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useUi.getState().rendererOverlayCount).toBe(1);
    get.mockResolvedValue(info);
    act(() => window.dispatchEvent(new Event(RUNTIME_RECONNECTED_EVENT)));
    expect(await screen.findByRole("textbox", { name: "Draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("keep my draft");
    expect(useUi.getState().rendererOverlayCount).toBe(0);
  });
  it("shows a dismissible legacy modal without displacing the workspace or repeating after reconnect", async () => {
    const get = vi.fn().mockResolvedValue({ version: "old" });
    useConnection.setState({ api: client(get) });
    const { container } = render(<RuntimeCompatibilityGate><div data-testid="workspace">Workspace</div></RuntimeCompatibilityGate>);
    const workspace = screen.getByTestId("workspace");
    expect(workspace.parentElement).toBe(container);
    await screen.findByRole("dialog", { name: "Update Matrix OS" });
    expect(document.querySelector("[data-dialog-titlebar]")?.classList.contains("titlebar-drag")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Workspace")).toBe(workspace);
    expect(useUi.getState().rendererOverlayCount).toBe(0);
    act(() => window.dispatchEvent(new Event(RUNTIME_RECONNECTED_EVENT)));
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === "/api/system/info").length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps the workspace mounted while checking and allows continuing after an incompatibility notice", async () => {
    useConnection.setState({ api: client(vi.fn().mockResolvedValue(future)) });
    render(<RuntimeCompatibilityGate><div data-testid="workspace">Workspace</div></RuntimeCompatibilityGate>);
    const workspace = screen.getByTestId("workspace");
    await screen.findByRole("dialog", { name: "Update Matrix OS" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Workspace")).toBe(workspace);
  });
  it("does not poll and throttles focus checks to once every 15 minutes", async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValue(info);
    const api = client(get);
    renderHook(() => useRuntimeCompatibility(api));
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(14 * 60_000); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); window.dispatchEvent(new Event("focus")); });
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("does not show an update modal when the initial network check fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const get = vi.fn().mockRejectedValue(new Error("offline"));
    useConnection.setState({ api: client(get) });
    render(<RuntimeCompatibilityGate><div>Workspace</div></RuntimeCompatibilityGate>);
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(useUi.getState().rendererOverlayCount).toBe(0);
  });
  it("keeps a working workspace during transient probe failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const get = vi.fn().mockResolvedValue(info);
    useConnection.setState({ api: client(get) });
    render(<RuntimeCompatibilityGate><div data-testid="workspace">Workspace</div></RuntimeCompatibilityGate>);
    const workspace = screen.getByTestId("workspace");
    await waitFor(() => expect(get).toHaveBeenCalledOnce());
    get.mockRejectedValue(new Error("offline"));
    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Workspace")).toBe(workspace);
  });
});
