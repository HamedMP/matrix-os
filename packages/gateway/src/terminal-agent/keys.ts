import { z } from "zod/v4";

const SIMPLE_KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  backspace: "\x7f",
  space: " ",
  delete: "\x1b[3~",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

// Final bytes of cursor keys; the prefix depends on the program's cursor-key mode (DECCKM).
const CURSOR_KEYS: Record<string, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};

const MODIFIED_LETTER = /^(ctrl|alt)\+([a-z])$/;

export const TerminalKeyNameSchema = z.string()
  .max(16)
  .transform((value) => value.trim().toLowerCase())
  // Own keys only: `in` would also accept inherited names such as `constructor`.
  .refine((value) => Object.hasOwn(SIMPLE_KEYS, value) || Object.hasOwn(CURSOR_KEYS, value) || MODIFIED_LETTER.test(value), {
    message: "Unknown key",
  });

export type TerminalKeyName = z.infer<typeof TerminalKeyNameSchema>;

/** Encode Herdr-style key names into the bytes a terminal keyboard would send. */
export function encodeTerminalKeys(
  keys: readonly string[],
  options: { applicationCursor?: boolean } = {},
): string {
  return keys.map((input) => {
    const key = TerminalKeyNameSchema.parse(input);
    if (Object.hasOwn(SIMPLE_KEYS, key)) return SIMPLE_KEYS[key]!;
    const cursor = Object.hasOwn(CURSOR_KEYS, key) ? CURSOR_KEYS[key] : undefined;
    if (cursor !== undefined) return `${options.applicationCursor ? "\x1bO" : "\x1b["}${cursor}`;
    const [, modifier, letter] = MODIFIED_LETTER.exec(key)!;
    if (modifier === "alt") return `\x1b${letter}`;
    return String.fromCharCode(letter!.charCodeAt(0) - 96);
  }).join("");
}
