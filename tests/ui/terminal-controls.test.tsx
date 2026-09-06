// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalControls } from "../../packages/ui/src/terminal/TerminalControls";
import { useTerminalControls } from "../../packages/ui/src/terminal/use-terminal-controls";
afterEach(cleanup);
const setup = () => ({
  sessionName: "alpha",
  enabled: true,
  isMac: true,
  sendInput: vi.fn(),
  focus: vi.fn(),
  transport: {
    getPreferences: vi
      .fn()
      .mockResolvedValue({
        preferences: { keyboard: { profile: "mac", overrides: {} } },
      }),
    savePreferences: vi
      .fn()
      .mockResolvedValue({
        preferences: { keyboard: { profile: "standard", overrides: {} } },
      }),
    paneAction: vi.fn().mockResolvedValue({ ok: true }),
  },
});
describe("shared terminal controls lifecycle", () => {
  it("consumes prefix then routes one pane action and consumes browser defaults", async () => {
    const opts = setup();
    const { result } = renderHook(() => useTerminalControls(opts));
    await waitFor(() =>
      expect(opts.transport.getPreferences).toHaveBeenCalled(),
    );
    act(() =>
      result.current.handleKeyEvent(
        new KeyboardEvent("keydown", { key: "g", ctrlKey: true }),
      ),
    );
    expect(result.current.prefixActive).toBe(true);
    const event = new KeyboardEvent("keydown", { key: "v", cancelable: true });
    act(() => result.current.handleKeyEvent(event));
    await waitFor(() =>
      expect(opts.transport.paneAction).toHaveBeenCalledWith("alpha", {
        type: "split",
        direction: "right",
      }),
    );
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.prefixActive).toBe(false);
    expect(opts.sendInput).not.toHaveBeenCalled();
  });
  it("does not carry prefix to a different session", async () => {
    const opts = setup();
    const { result, rerender } = renderHook((p) => useTerminalControls(p), {
      initialProps: opts,
    });
    act(() =>
      result.current.handleKeyEvent(
        new KeyboardEvent("keydown", { key: "g", ctrlKey: true }),
      ),
    );
    rerender({ ...opts, sessionName: "beta" });
    act(() =>
      expect(
        result.current.handleKeyEvent(
          new KeyboardEvent("keydown", { key: "v" }),
        ),
      ).toBe(true),
    );
    expect(opts.transport.paneAction).not.toHaveBeenCalled();
  });
  it("keeps editing usable while pane actions are disabled", async () => {
    const opts = setup();
    const { result } = renderHook(() =>
      useTerminalControls({ ...opts, paneActionsEnabled: false }),
    );
    act(() =>
      result.current.handleKeyEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true }),
      ),
    );
    expect(opts.sendInput).toHaveBeenCalledWith("\x01");
    await act(() => result.current.runAction({ type: "close" }));
    expect(opts.transport.paneAction).not.toHaveBeenCalled();
  });
  it("does not leak failed save details or replace confirmed preferences", async () => {
    const opts = setup();
    opts.transport.savePreferences.mockRejectedValue(
      new Error("postgres private/path"),
    );
    const { result } = renderHook(() => useTerminalControls(opts));
    await waitFor(() =>
      expect(opts.transport.getPreferences).toHaveBeenCalled(),
    );
    await act(() =>
      result.current.savePreferences({ profile: "standard", overrides: {} }),
    );
    expect(result.current.preferences.profile).toBe("mac");
    expect(result.current.error).not.toMatch(/postgres|private/);
  });
  it("ignores stale action completion after session changes", async () => {
    const opts = setup();
    let finish!: () => void;
    opts.transport.paneAction.mockImplementation(
      () => new Promise<void>((r) => (finish = r)),
    );
    const { result, rerender } = renderHook((p) => useTerminalControls(p), {
      initialProps: opts,
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runAction({ type: "fullscreen" });
    });
    rerender({ ...opts, sessionName: "beta" });
    await act(async () => {
      finish();
      await pending;
    });
    expect(opts.focus).not.toHaveBeenCalled();
  });
  it("catches synchronous load failures and ignores composition events", async () => {
    const opts = setup();
    opts.transport.getPreferences.mockImplementation(() => {
      throw Error("load failed");
    });
    const { result } = renderHook(() => useTerminalControls(opts));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    act(() =>
      expect(
        result.current.handleKeyEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowLeft",
            metaKey: true,
            isComposing: true,
          }),
        ),
      ).toBe(true),
    );
    expect(opts.sendInput).not.toHaveBeenCalled();
  });
});
it("cancels a pending close confirmation when the terminal target changes", async () => {
  const opts = setup();
  function Harness({ name }: { name: string }) {
    const controls = useTerminalControls({ ...opts, sessionName: name });
    return <TerminalControls controls={controls} />;
  }
  const view = render(<Harness name="alpha" />);
  fireEvent.click(
    view.getByRole("button", { name: "Close pane", exact: true, hidden: true }),
  );
  expect(view.getByRole("alertdialog")).toBeTruthy();
  view.rerender(<Harness name="beta" />);
  expect(view.queryByRole("alertdialog")).toBeNull();
  expect(opts.transport.paneAction).not.toHaveBeenCalled();
});
it("edits and saves custom keyboard settings through the shared toolbar", async () => {
  const opts = setup();
  function Harness() {
    return <TerminalControls controls={useTerminalControls(opts)} />;
  }
  const view = render(<Harness />);
  await waitFor(() => expect(opts.transport.getPreferences).toHaveBeenCalled());
  fireEvent.change(view.getByLabelText("Shortcut profile"), {
    target: { value: "standard" },
  });
  fireEvent.click(view.getByText("Save shortcuts"));
  await waitFor(() =>
    expect(opts.transport.savePreferences).toHaveBeenCalledWith({
      profile: "standard",
      overrides: {},
    }),
  );
});
it("keeps the pane prefix armed while Shift is pressed before a resize arrow", async () => {
  const opts = setup();
  const { result } = renderHook(() => useTerminalControls(opts));
  act(() =>
    result.current.handleKeyEvent(
      new KeyboardEvent("keydown", { key: "g", ctrlKey: true }),
    ),
  );
  act(() =>
    result.current.handleKeyEvent(
      new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }),
    ),
  );
  act(() =>
    result.current.handleKeyEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true }),
    ),
  );
  await waitFor(() =>
    expect(opts.transport.paneAction).toHaveBeenCalledWith("alpha", {
      type: "resize",
      direction: "left",
    }),
  );
});
it("disables edits while keyboard settings are saving", async () => {
  const opts = setup();
  let finish!: (v: unknown) => void;
  opts.transport.savePreferences.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  function Harness() {
    return <TerminalControls controls={useTerminalControls(opts)} />;
  }
  const view = render(<Harness />);
  await waitFor(() => expect(opts.transport.getPreferences).toHaveBeenCalled());
  fireEvent.click(view.getByText("Save shortcuts"));
  expect(
    (view.getByLabelText("Shortcut profile") as HTMLSelectElement).disabled,
  ).toBe(true);
  expect((view.getByText("Save shortcuts") as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () =>
    finish({ preferences: { keyboard: { profile: "mac", overrides: {} } } }),
  );
  expect(
    (view.getByLabelText("Shortcut profile") as HTMLSelectElement).disabled,
  ).toBe(false);
});
it("keeps a pane action serialized while its transport refreshes", async () => {
  const opts = setup();
  let finish!: () => void;
  opts.transport.paneAction.mockImplementation(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  const { result, rerender } = renderHook((p) => useTerminalControls(p), {
    initialProps: opts,
  });
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.runAction({ type: "split", direction: "right" });
  });
  const replacement = {
    ...opts.transport,
    paneAction: vi.fn().mockResolvedValue({ ok: true }),
  };
  rerender({ ...opts, transport: replacement });
  expect(result.current.busy).toBe(true);
  await act(() => result.current.runAction({ type: "fullscreen" }));
  expect(replacement.paneAction).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await pending;
  });
  expect(result.current.busy).toBe(false);
});
