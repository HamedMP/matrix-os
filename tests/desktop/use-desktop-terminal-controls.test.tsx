// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalPaneAction } from "@matrix-os/contracts";
import { useDesktopTerminalControls } from "@desktop/renderer/src/features/terminal/use-desktop-terminal-controls";

// Spec 2706: in the Terminal window, the terminal's pane buttons and keys drive the window's panes.
function options(overrides: { sessionName?: string; onPaneAction?: (action: TerminalPaneAction) => void; api?: unknown } = {}) {
  const term = { focus: vi.fn(), scrollToTop: vi.fn(), scrollToBottom: vi.fn() };
  return {
    term,
    props: {
      api: (overrides.api ?? null) as never,
      sessionName: overrides.sessionName ?? "local:t1",
      active: true,
      socketState: "attached" as const,
      writable: true,
      isMac: true,
      attachmentRef: { current: null },
      termRef: { current: term },
      onPaneAction: overrides.onPaneAction,
    },
  };
}

describe("useDesktopTerminalControls in the Terminal window", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // Fault detected (Greptile, #3569): a new pane-action callback on each redraw rebuilt the
  // transport, reloading keyboard preferences and dropping a Ctrl+G prefix.
  it("keeps one transport across redraws and runs the latest pane callback", async () => {
    const api = { get: vi.fn(async () => ({ preferences: { keyboard: { profile: "mac", overrides: {} } } })), put: vi.fn(), post: vi.fn() };
    const first = vi.fn();
    const { props } = options({ sessionName: "ws1:tab1", onPaneAction: first, api });
    const { result, rerender } = renderHook((current: typeof props) => useDesktopTerminalControls(current), { initialProps: props });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    const latest = vi.fn();
    rerender({ ...props, onPaneAction: latest });
    rerender({ ...props, onPaneAction: latest });
    await act(async () => { await result.current.runAction({ type: "split", direction: "right" }); });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith({ type: "split", direction: "right" });
  });

  // Fault detected (Greptile, #3569): History top/bottom did nothing in a local terminal,
  // or went to the computer's gateway with a local session name.
  it("scrolls a local terminal's own history instead of forwarding it", async () => {
    const api = { get: vi.fn(async () => ({ preferences: { keyboard: { profile: "mac", overrides: {} } } })), put: vi.fn(), post: vi.fn() };
    const onPaneAction = vi.fn();
    const { props, term } = options({ onPaneAction, api });
    const { result } = renderHook(() => useDesktopTerminalControls(props));
    await act(async () => { await result.current.runAction({ type: "scroll", edge: "top" }); });
    await act(async () => { await result.current.runAction({ type: "scroll", edge: "bottom" }); });
    expect(term.scrollToTop).toHaveBeenCalledOnce();
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
    expect(onPaneAction).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
