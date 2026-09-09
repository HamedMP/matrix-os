// @vitest-environment jsdom
import { AppError } from "../../desktop/src/shared/app-error";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useDesktopTerminalControls } from "@desktop/renderer/src/features/terminal/use-desktop-terminal-controls";

function setup() {
  const api = {
    get: vi
      .fn()
      .mockResolvedValue({
        preferences: { keyboard: { profile: "mac", overrides: {} } },
      }),
    put: vi
      .fn()
      .mockResolvedValue({
        preferences: { keyboard: { profile: "passthrough", overrides: {} } },
      }),
    post: vi.fn().mockResolvedValue({ ok: true }),
  };
  const write = vi.fn();
  const focus = vi.fn();
  const attachment = {
    current: { sessionName: "session-one", write, resize: vi.fn() },
  };
  const terminal = { current: { focus } };
  const initialProps = {
    api: api as unknown as ApiClient,
    sessionName: "session-one",
    active: true,
    socketState: "attached" as const,
    leaseRevoked: false,
    isMac: true,
    attachmentRef: attachment,
    termRef: terminal,
  };
  return { api, write, focus, attachment, terminal, initialProps };
}

afterEach(cleanup);

describe("Electron Desktop shared terminal controls", () => {
  it.each([
    ["ArrowLeft", { metaKey: true }, "\x01"],
    ["ArrowRight", { metaKey: true }, "\x05"],
    ["ArrowLeft", { altKey: true }, "\x1bb"],
    ["ArrowRight", { altKey: true }, "\x1bf"],
    ["Backspace", { altKey: true }, "\x1b\x7f"],
    ["Backspace", { metaKey: true }, "\x15"],
  ])(
    "sends %s %j once through the active attachment",
    async (key, modifiers, expected) => {
      const { api, write, initialProps } = setup();
      const { result } = renderHook(() =>
        useDesktopTerminalControls(initialProps),
      );
      await waitFor(() =>
        expect(api.get).toHaveBeenCalledWith("/api/terminal/preferences"),
      );
      const event = new KeyboardEvent("keydown", {
        key,
        ...modifiers,
        cancelable: true,
      });
      act(() => expect(result.current.handleKeyEvent(event)).toBe(false));
      expect(event.defaultPrevented).toBe(true);
      expect(write).toHaveBeenCalledExactlyOnceWith(expected);
    },
  );

  it("targets pane actions at the current session and keeps stable transport across redraws", async () => {
    const { api, initialProps } = setup();
    const { result, rerender } = renderHook(
      (props) => useDesktopTerminalControls(props),
      { initialProps },
    );
    await act(async () => {
      await result.current.runAction({ type: "split", direction: "right" });
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/terminal/sessions/session-one/pane-actions",
      { type: "split", direction: "right" },
    );
    rerender({ ...initialProps });
    expect(api.get).toHaveBeenCalledTimes(1);
    rerender({ ...initialProps, sessionName: "session-two" });
    await act(async () => {
      await result.current.runAction({ type: "fullscreen" });
    });
    expect(api.post).toHaveBeenLastCalledWith(
      "/api/terminal/sessions/session-two/pane-actions",
      { type: "fullscreen" },
    );
  });

  it("includes Chat authorization context for an embedded Chat terminal", async () => {
    const { api, initialProps } = setup();
    const { result } = renderHook(() =>
      useDesktopTerminalControls({ ...initialProps, chatId: "chat-one" }),
    );
    await act(async () => {
      await result.current.runAction({ type: "split", direction: "down" });
    });
    expect(api.post).toHaveBeenCalledWith(
      "/api/terminal/sessions/session-one/pane-actions?chatId=chat-one",
      { type: "split", direction: "down" },
    );
  });

  it("does not write editing sequences into an attachment from the previous session", async () => {
    const { api, write, initialProps } = setup();
    const { result, rerender } = renderHook(
      (props) => useDesktopTerminalControls(props),
      { initialProps },
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    rerender({ ...initialProps, sessionName: "session-two" });
    act(() =>
      result.current.handleKeyEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true }),
      ),
    );
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { active: false },
    { socketState: "reconnecting" as const },
    { socketState: "connecting" as const },
    { leaseRevoked: true },
    { api: null },
  ])(
    "disables controls when the input lease is unavailable: %j",
    async (override) => {
      const { api, write, initialProps } = setup();
      const { result } = renderHook(() =>
        useDesktopTerminalControls({ ...initialProps, ...override }),
      );
      expect(result.current.enabled).toBe(false);
      await act(async () => {
        await result.current.runAction({ type: "close" });
      });
      act(() =>
        result.current.handleKeyEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true }),
        ),
      );
      expect(api.post).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("saves keyboard settings through the authenticated preferences API", async () => {
    const { api, initialProps } = setup();
    const { result } = renderHook(() =>
      useDesktopTerminalControls(initialProps),
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await act(async () => {
      await result.current.savePreferences({
        profile: "passthrough",
        overrides: {},
      });
    });
    expect(api.put).toHaveBeenCalledWith("/api/terminal/preferences", {
      keyboard: { profile: "passthrough", overrides: {} },
    });
  });

  it("reports a safe error without disposing the terminal after a failed pane action", async () => {
    const { api, initialProps, attachment } = setup();
    api.post.mockRejectedValue(
      new Error("private gateway /home/operator failure"),
    );
    const { result } = renderHook(() =>
      useDesktopTerminalControls(initialProps),
    );
    await act(async () => {
      await result.current.runAction({ type: "close" });
    });
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toMatch(/operator|gateway|\/home/);
    expect(attachment.current.sessionName).toBe("session-one");
  });
});

it("retries a missing standalone split route on older hosts", async () => {
  const { api, initialProps } = setup();
  api.post.mockRejectedValueOnce(new AppError("notFound"));
  const { result } = renderHook(() => useDesktopTerminalControls(initialProps));
  await act(async () => {
    await result.current.runAction({ type: "split", direction: "right" });
  });
  expect(api.post).toHaveBeenLastCalledWith(
    "/api/terminal/sessions/session-one/panes",
    { direction: "right" },
  );
  expect(result.current.error).toBeNull();
});
it("does not retry a recognized session-not-found response", async () => {
  const { api, initialProps } = setup();
  api.post.mockRejectedValueOnce(
    new AppError("notFound", { detail: "session_not_found" }),
  );
  const { result } = renderHook(() => useDesktopTerminalControls(initialProps));
  await act(async () => {
    await result.current.runAction({ type: "split", direction: "right" });
  });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(result.current.error).toContain("could not be completed");
});
