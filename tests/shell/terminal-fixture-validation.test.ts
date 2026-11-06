import { describe, expect, it, vi } from "vitest";
import {
  ValidatedTerminalFixtureSocket,
  type TerminalFixtureClientFrame,
} from "../e2e/fixtures/validated-terminal-socket.js";

const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };

class CaptureSocket extends ValidatedTerminalFixtureSocket {
  readonly frames: TerminalFixtureClientFrame[] = [];

  protected onClientFrame(frame: TerminalFixtureClientFrame): void {
    this.frames.push(frame);
  }
}

describe("browser terminal fixture consumer boundary", () => {
  it("rejects a paste frame missing canonical terminal identity before recording input", () => {
    const socket = new CaptureSocket(ref);
    expect(() => socket.send(JSON.stringify({ type: "input", data: "paste payload" }))).toThrow();
    expect(socket.frames).toEqual([]);
  });

  it.each([
    { ...ref, workspaceId: `tws_${"c".repeat(32)}` },
    { ...ref, tabId: `tt_${"d".repeat(32)}` },
  ])("rejects a valid frame for a different workspace or tab: %j", terminalRef => {
    const socket = new CaptureSocket(ref);
    expect(() => socket.send(JSON.stringify({ type: "input", terminalRef, data: "wrong target" }))).toThrow();
    expect(socket.frames).toEqual([]);
  });

  it.each([
    { name: "empty input", frame: { type: "input", terminalRef: ref, data: "" } },
    { name: "oversized input", frame: { type: "input", terminalRef: ref, data: "x".repeat(65_537) } },
    { name: "invalid binary", frame: { type: "binary", terminalRef: ref, dataBase64: "not base64!" } },
    { name: "missing resize mode", frame: { type: "resize", terminalRef: ref, size: { cols: 80, rows: 24 } } },
  ])("rejects $name before fixture processing", ({ frame }) => {
    const socket = new CaptureSocket(ref);
    expect(() => socket.send(JSON.stringify(frame))).toThrow();
    expect(socket.frames).toEqual([]);
  });

  it.each([
    { name: "invalid background frame", raw: JSON.stringify({ type: "ping" }) },
    { name: "malformed JSON", raw: "{" },
  ])("reports $name even when the caller catches the send failure", ({ raw }) => {
    const events: string[] = [];
    const socket = new CaptureSocket(ref, () => events.push("reported"));
    try {
      socket.send(raw);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      events.push("caught");
    }
    expect(events).toEqual(["reported", "caught"]);
    expect(socket.frames).toEqual([]);
  });

  it("accepts canonical input and control frames for exactly the active tab", () => {
    const rejected = vi.fn();
    const socket = new CaptureSocket(ref, rejected);
    const frames = [
      { type: "input", terminalRef: ref, data: "\x1b[200~paste λ\x1b[201~" },
      { type: "binary", terminalRef: ref, dataBase64: "YQ==" },
      { type: "resize", terminalRef: ref, size: { cols: 80, rows: 24 }, mode: "soft" },
      { type: "scroll-query", terminalRef: ref },
      { type: "scroll-to", terminalRef: ref, line: 10 },
      { type: "ping", terminalRef: ref },
      { type: "detach", terminalRef: ref },
    ];
    for (const frame of frames) socket.send(JSON.stringify(frame));
    expect(socket.frames).toEqual(frames);
    expect(rejected).not.toHaveBeenCalled();
  });
});
