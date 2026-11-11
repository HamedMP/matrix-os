import { describe, expect, it } from "vitest";
import {
  encodeTerminalKeys,
  TerminalKeyNameSchema,
} from "../../packages/gateway/src/terminal-agent/keys.js";

// Fault detected: an agent pressing named keys sends the wrong bytes, so a
// trust dialog, menu or prompt in the program never sees the intended key.
describe("terminal named keys", () => {
  it("encodes editing and control keys the way a terminal keyboard does", () => {
    expect(encodeTerminalKeys(["enter", "esc", "tab", "backspace", "space"])).toBe("\r\x1b\t\x7f ");
    expect(encodeTerminalKeys(["ctrl+c", "ctrl+d", "ctrl+a", "ctrl+z"])).toBe("\x03\x04\x01\x1a");
    expect(encodeTerminalKeys(["alt+b", "shift+tab", "delete"])).toBe("\x1bb\x1b[Z\x1b[3~");
    expect(encodeTerminalKeys(["pageup", "pagedown", "f1", "f5", "f12"])).toBe(
      "\x1b[5~\x1b[6~\x1bOP\x1b[15~\x1b[24~",
    );
  });

  it("follows the program's cursor-key mode for arrows, home and end", () => {
    expect(encodeTerminalKeys(["up", "down", "right", "left", "home", "end"])).toBe(
      "\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F",
    );
    expect(encodeTerminalKeys(["up", "down", "home"], { applicationCursor: true })).toBe(
      "\x1bOA\x1bOB\x1bOH",
    );
  });

  it("accepts key names case-insensitively and rejects anything else", () => {
    expect(TerminalKeyNameSchema.parse("Ctrl+C")).toBe("ctrl+c");
    expect(TerminalKeyNameSchema.parse("ENTER")).toBe("enter");
    for (const bad of ["ctrl+1", "alt+", "hyper+a", "f13", "rm -rf", "\x1b[A", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(TerminalKeyNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
