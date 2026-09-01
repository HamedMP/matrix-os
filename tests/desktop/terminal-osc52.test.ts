// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decodeOsc52Clipboard } from "@desktop/renderer/src/features/terminal/terminal-osc52";

describe("desktop terminal OSC 52 clipboard", () => {
  it("decodes a bounded system clipboard write", () => {
    const encoded = btoa(unescape(encodeURIComponent("selected α\nsecond line")));
    expect(decodeOsc52Clipboard(`c;${encoded}`)).toEqual({
      handled: true,
      text: "selected α\nsecond line",
    });
  });

  it("handles queries without exposing clipboard data", () => {
    expect(decodeOsc52Clipboard("c;?")).toEqual({ handled: true, text: null });
  });

  it("rejects unsupported targets and malformed payloads", () => {
    expect(decodeOsc52Clipboard("x;c3RhbGU=")).toEqual({ handled: false });
    expect(decodeOsc52Clipboard("c;not base64!")).toEqual({ handled: false });
  });
});
