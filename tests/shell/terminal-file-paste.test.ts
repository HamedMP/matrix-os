import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_CLOSE,
  BRACKETED_PASTE_OPEN,
  filesFromTerminalFilePayload,
  splitBracketedPastePayload,
  terminalPasteMimeType,
} from "../../shell/src/components/terminal/terminal-file-paste.js";

function file(name: string, type = ""): File {
  return { name, type } as File;
}

describe("terminal file paste", () => {
  it("accepts supported image MIME types and falls back to the filename extension", () => {
    expect(terminalPasteMimeType(file("capture.bin", "IMAGE/PNG"))).toBe("image/png");
    expect(terminalPasteMimeType(file("capture.JPEG"))).toBe("image/jpeg");
    expect(terminalPasteMimeType(file("notes.txt", "text/plain"))).toBeNull();
  });

  it("captures every supported file item before asynchronous upload work starts", () => {
    const png = file("one.png");
    const webp = file("two.webp");
    const payload = {
      items: [
        { kind: "file", getAsFile: () => png },
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => webp },
      ],
      files: [],
    } as unknown as DataTransfer;

    expect(filesFromTerminalFilePayload(payload)).toEqual([png, webp]);
  });

  it("splits bracketed paste payloads without exceeding the terminal input limit", () => {
    const chunks = splitBracketedPastePayload(["a".repeat(70_000), "tail"]);
    const overhead = BRACKETED_PASTE_OPEN.length + BRACKETED_PASTE_CLOSE.length;

    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(`${"a".repeat(70_000)} tail`);
    expect(chunks.every((chunk) => chunk.length + overhead <= 65_536)).toBe(true);
  });
});
