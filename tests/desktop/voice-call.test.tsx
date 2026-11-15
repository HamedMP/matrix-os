// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopTaskbar from "@desktop/renderer/src/features/desktop-shell/DesktopTaskbar";
import DesktopVoiceCall from "@desktop/renderer/src/features/voice/DesktopVoiceCall";
import { buildVoiceLiveWsUrl, useDesktopVoiceCall } from "@desktop/renderer/src/features/voice/voice-call-store";
import { useConnection } from "@desktop/renderer/src/stores/connection";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  receive(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  useDesktopVoiceCall.setState(useDesktopVoiceCall.getInitialState(), true);
  useConnection.setState({ platformHost: "https://app.matrix-os.com", runtimeSlot: "pr-3392" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("buildVoiceLiveWsUrl", () => {
  it("targets the selected computer through the platform and carries the Chat", () => {
    expect(buildVoiceLiveWsUrl("https://app.matrix-os.com/", "primary")).toBe("wss://app.matrix-os.com/ws/voice/live");
    expect(buildVoiceLiveWsUrl("https://app.matrix-os.com", "pr-3392", "chat_a b"))
      .toBe("wss://app.matrix-os.com/ws/voice/live?runtime=pr-3392&chatId=chat_a+b");
  });
});

describe("Electron Desktop voice entry points", () => {
  it("starts and ends a call from the taskbar", () => {
    render(<DesktopTaskbar tabs={[]} surfaces={{}} activeTabId={null} onOpenApps={vi.fn()} onOpenFiles={vi.fn()}
      launcherOpen={false} onActivate={vi.fn()} />);
    const bar = screen.getByRole("navigation", { name: "Running apps" });
    fireEvent.click(within(bar).getByRole("button", { name: "Talk with Matrix" }));
    expect(useDesktopVoiceCall.getState()).toMatchObject({ active: true, chatId: undefined });
    fireEvent.click(within(bar).getByRole("button", { name: "End voice call" }));
    expect(useDesktopVoiceCall.getState().active).toBe(false);
  });

  it("joins the requested Chat, follows the call state and reports a blocked microphone", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) } });
    act(() => useDesktopVoiceCall.getState().start("chat_pi"));
    render(<DesktopVoiceCall />);
    await act(async () => {});
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("wss://app.matrix-os.com/ws/voice/live?runtime=pr-3392&chatId=chat_pi");
    expect(screen.getByTestId("voice-live-panel").getAttribute("data-status")).toBe("connecting");

    await act(async () => { socket.receive({ type: "session.ready", chatId: "chat_pi" }); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Microphone access is blocked. Allow microphone access and try again.");
    expect(socket.closed).toBe(true);
  });

  it("ends the call and closes the socket from the End button", async () => {
    act(() => useDesktopVoiceCall.getState().start());
    render(<DesktopVoiceCall />);
    await act(async () => {});
    const socket = FakeSocket.instances[0]!;
    fireEvent.click(screen.getByRole("button", { name: "End voice call" }));
    expect(socket.sent).toContain(JSON.stringify({ type: "end" }));
    expect(useDesktopVoiceCall.getState().active).toBe(false);
    expect(screen.queryByTestId("voice-live-panel")).toBeNull();
  });
});
