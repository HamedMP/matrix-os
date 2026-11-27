/** Field codes: `REF _Ref123 \h`, `HYPERLINK "https://…" \l "anchor"`, `TOC \o "1-3"`. */

import type { FieldKind, Hyperlink } from "../../api/docx-model.js";

export interface ParsedField {
  readonly kind: FieldKind;
  /** The field type in upper case, for example `PAGEREF`; empty when the code is blank. */
  readonly type: string;
  /** The code as written, trimmed. */
  readonly instruction: string;
  /** Arguments that are not switches, without their quotes. */
  readonly args: readonly string[];
  /** Switch name (for example `\l`) to its argument, or to an empty string when it has none. */
  readonly switches: ReadonlyMap<string, string>;
  /** The bookmark a `REF`, `PAGEREF` or `NOTEREF` field points at, else null. */
  readonly targetBookmark: string | null;
}

const KINDS: Readonly<Record<string, FieldKind>> = {
  REF: "ref",
  PAGEREF: "pageRef",
  NOTEREF: "noteRef",
  HYPERLINK: "hyperlink",
  TOC: "toc",
  PAGE: "page",
  NUMPAGES: "numPages",
  DATE: "date",
  TIME: "date",
  CREATEDATE: "date",
  SAVEDATE: "date",
  PRINTDATE: "date",
};

/** Switches of a field type that take the next token as their argument. */
const SWITCHES_WITH_ARGUMENT: Readonly<Record<string, ReadonlySet<string>>> = {
  HYPERLINK: new Set(["\\l", "\\o", "\\t", "\\m"]),
  TOC: new Set(["\\o", "\\t", "\\b", "\\f", "\\l", "\\a", "\\c", "\\d", "\\n", "\\p", "\\s"]),
  DATE: new Set(["\\@"]),
  TIME: new Set(["\\@"]),
  CREATEDATE: new Set(["\\@"]),
  SAVEDATE: new Set(["\\@"]),
  PRINTDATE: new Set(["\\@"]),
};

function tokenize(code: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < code.length && tokens.length < 64) {
    const char = code[index] as string;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
    } else if (char === '"') {
      const close = code.indexOf('"', index + 1);
      const end = close === -1 ? code.length : close;
      tokens.push(`"${code.slice(index + 1, end)}`);
      index = end + 1;
    } else {
      let end = index;
      while (end < code.length && !/\s/.test(code[end] as string)) end += 1;
      tokens.push(code.slice(index, end));
      index = end;
    }
  }
  return tokens;
}

const unquote = (token: string): string => (token.startsWith('"') ? token.slice(1) : token);

export function parseFieldInstruction(code: string): ParsedField {
  const instruction = code.trim();
  const tokens = tokenize(instruction);
  const type = (tokens[0] ?? "").toUpperCase();
  const withArgument = SWITCHES_WITH_ARGUMENT[type];
  const args: string[] = [];
  const switches = new Map<string, string>();
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index] as string;
    if (token.startsWith("\\")) {
      const next = tokens[index + 1];
      if (withArgument?.has(token.toLowerCase()) === true && next !== undefined && !next.startsWith("\\")) {
        switches.set(token.toLowerCase(), unquote(next));
        index += 1;
      } else {
        switches.set(token.toLowerCase(), "");
      }
    } else {
      args.push(unquote(token));
    }
  }
  const kind = KINDS[type] ?? "other";
  const pointsAtBookmark = kind === "ref" || kind === "pageRef" || kind === "noteRef";
  return {
    kind,
    type,
    instruction,
    args,
    switches,
    targetBookmark: pointsAtBookmark ? (args[0] ?? null) : null,
  };
}

/** The link a `HYPERLINK` field makes, or null for any other field. */
export function hyperlinkOfField(field: ParsedField): Hyperlink | null {
  if (field.kind !== "hyperlink") return null;
  const address = field.args[0] ?? null;
  const anchor = field.switches.get("\\l") ?? null;
  const tooltip = field.switches.get("\\o") ?? null;
  return {
    href: address === null || address === "" ? null : address,
    anchor: anchor === null || anchor === "" ? null : anchor,
    tooltip: tooltip === null || tooltip === "" ? null : tooltip,
  };
}
