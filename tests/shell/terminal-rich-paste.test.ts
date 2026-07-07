import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bracketTerminalPaste,
  clipboardDataHasImage,
  pasteClipboardDataIntoTerminal,
  pasteClipboardIntoTerminal,
  terminalPasteImagePath,
} from "../../shell/src/components/terminal/terminal-rich-paste.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal rich clipboard paste", () => {
  it("wraps text in bracketed paste and strips nested bracket markers", () => {
    expect(bracketTerminalPaste("a\x1b[200~b\x1b[201~c")).toBe("\x1b[200~abc\x1b[201~");
  });

  it("uses stable image paste paths for supported clipboard image types", () => {
    const path = terminalPasteImagePath("image/png", new Date("2026-06-24T12:34:56.789Z"));
    expect(path).toMatch(/^data\/terminal-paste\/paste-20260624T123456Z-[a-f0-9-]{8}\.png$/);
  });


  it("uploads images from paste event clipboard data", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const signal = AbortSignal.abort().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchMock = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["event image"], { type: "image/png" });
    const clipboardData = {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: vi.fn(() => blob),
        },
      ],
      files: [],
    };
    const ws = { readyState: 1, send: vi.fn() };

    expect(clipboardDataHasImage(clipboardData)).toBe(true);
    await expect(pasteClipboardDataIntoTerminal({
      clipboardData,
      gatewayUrl: "https://gateway.example",
      ws,
    })).resolves.toBe("image");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/gateway\.example\/api\/files\/blob\?path=data%2Fterminal-paste%2Fpaste-/),
      expect.objectContaining({ method: "PUT", body: blob, signal }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    const sent = JSON.parse(ws.send.mock.calls[0]![0]);
    expect(sent.data).toContain("~/data/terminal-paste/paste-");
    expect(sent.data).toContain(".png");
  });

  it("uploads clipboard images and pastes their Matrix file path", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const fetchMock = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["fake image"], { type: "image/png" });
    const clipboard = {
      read: vi.fn(async () => [
        {
          types: ["image/png"],
          getType: vi.fn(async () => blob),
        },
      ]),
      readText: vi.fn(async () => "fallback text"),
    };
    const ws = { readyState: 1, send: vi.fn() };

    await expect(pasteClipboardIntoTerminal({
      clipboard,
      gatewayUrl: "https://gateway.example",
      ws,
    })).resolves.toBe("image");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/gateway\.example\/api\/files\/blob\?path=data%2Fterminal-paste%2Fpaste-/),
      expect.objectContaining({ method: "PUT", body: blob }),
    );
    expect(clipboard.readText).not.toHaveBeenCalled();
    const sent = JSON.parse(ws.send.mock.calls[0]![0]);
    expect(sent).toMatchObject({ type: "input" });
    expect(sent.data.startsWith("\x1b[200~~/data/terminal-paste/paste-")).toBe(true);
    expect(sent.data.endsWith(".png\x1b[201~")).toBe(true);
  });

  it("keeps the native clipboard read method bound to the clipboard object", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    const blob = new Blob(["fake image"], { type: "image/png" });
    const clipboard = {
      readText: vi.fn(async () => "fallback text"),
      async read() {
        if (this !== clipboard) {
          throw new TypeError("Illegal invocation");
        }
        return [
          {
            types: ["image/png"],
            getType: vi.fn(async () => blob),
          },
        ];
      },
    };
    const ws = { readyState: 1, send: vi.fn() };

    await expect(pasteClipboardIntoTerminal({
      clipboard,
      gatewayUrl: "https://gateway.example",
      ws,
    })).resolves.toBe("image");

    expect(clipboard.readText).not.toHaveBeenCalled();
    const sent = JSON.parse(ws.send.mock.calls[0]![0]);
    expect(sent.data).toContain("~/data/terminal-paste/paste-");
  });
});
