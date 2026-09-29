// @vitest-environment jsdom
import React, { useRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalFilePaste } from "../../shell/src/components/terminal/useTerminalFilePaste";

vi.mock("@/lib/gateway", () => ({ getGatewayUrl: () => "https://gateway.test" }));
vi.mock("@/lib/websocket-auth", () => ({ getWebSocketAuthToken: async () => "test-token" }));
const sessionId = `tws_${"a".repeat(32)}:tt_${"b".repeat(32)}`;
const send = vi.fn();
const reportPasteFailure = vi.fn();
const reportPasteSuccess = vi.fn();

function FilePasteHarness() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useTerminalFilePaste({
    containerRef,
    cwd: "projects",
    feedbackSequenceRef: useRef(0),
    operationGenerationRef: useRef(0),
    reportPasteFailure,
    reportPasteSuccess,
    sessionIdRef: useRef(sessionId),
    socketGenerationRef: useRef(1),
    wsRef: useRef({ readyState: WebSocket.OPEN, send } as unknown as WebSocket),
  });
  return <div ref={containerRef} data-testid="terminal-host"><textarea /></div>;
}

function dragEvent(type: string, payload: object) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: payload });
  return event;
}

describe("Web Terminal protected file drag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      assets: [{ terminalPath: "/home/matrix/home/projects/design.png" }],
    }))));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each(["dragenter", "dragover"])("accepts %s before the browser exposes file bytes", async (type) => {
    const { getByTestId } = render(<FilePasteHarness />);
    const host = getByTestId("terminal-host");
    const bubble = vi.fn();
    host.addEventListener(type, bubble);
    const getAsFile = vi.fn(() => null);
    const payload = { types: ["Files"], items: [{ kind: "file", type: "image/png", getAsFile }], files: [], dropEffect: "none" };
    const event = dragEvent(type, payload);
    host.querySelector("textarea")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(payload.dropEffect).toBe("copy");
    expect(bubble).not.toHaveBeenCalled();
    expect(getAsFile).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const file = new File(["png"], "design.png", { type: "image/png" });
    host.dispatchEvent(dragEvent("drop", { files: [file], items: [], types: ["Files"] }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "input",
      terminalRef: { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` },
      data: "\u001b[200~/home/matrix/home/projects/design.png\u001b[201~",
    })));
    expect(fetch).toHaveBeenCalledOnce();
    expect(reportPasteFailure).not.toHaveBeenCalled();
  });

  it("accepts a Files-only drag and leaves text drags untouched", () => {
    const { getByTestId } = render(<FilePasteHarness />);
    const host = getByTestId("terminal-host");
    const fileEvent = dragEvent("dragover", { types: ["Files"], files: [], items: [], dropEffect: "none" });
    host.dispatchEvent(fileEvent);
    expect(fileEvent.defaultPrevented).toBe(true);
    const textEvent = dragEvent("dragover", { types: ["text/plain"], files: [], items: [{ kind: "string" }], dropEffect: "move" });
    host.dispatchEvent(textEvent);
    expect(textEvent.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["brief.pdf", "application/pdf", "%PDF-1.7"],
    ["说明.txt", "text/plain", "design notes"],
    ["archive.zip", "application/zip", "zip bytes"],
    ["unknown.bin", "", "binary bytes"],
    ["empty.txt", "text/plain", ""],
  ])("uploads dropped file %s without losing its bytes", async (name, type, contents) => {
    const { getByTestId } = render(<FilePasteHarness />);
    const file = new File([contents], name, { type });
    const event = dragEvent("drop", { files: [file], items: [] });
    getByTestId("terminal-host").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const options = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toEqual({ kind: "file", assets: [{
      name, mimeType: type || "application/octet-stream", dataBase64: btoa(contents),
    }] });
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(reportPasteFailure).not.toHaveBeenCalled();
  });

  it("rejects too many or oversized dropped files before uploading", () => {
    const { getByTestId } = render(<FilePasteHarness />);
    const host = getByTestId("terminal-host");
    host.dispatchEvent(dragEvent("drop", { files: Array.from({ length: 9 }, (_, n) => new File(["x"], `${n}.txt`)) }));
    expect(reportPasteFailure).toHaveBeenLastCalledWith(expect.any(Number), "Upload up to 8 files at a time.");
    const big = new File(["x"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    host.dispatchEvent(dragEvent("drop", { files: [big] }));
    expect(reportPasteFailure).toHaveBeenLastCalledWith(expect.any(Number), "Files are limited to 10 MB.");
    expect(fetch).not.toHaveBeenCalled();
  });

});
