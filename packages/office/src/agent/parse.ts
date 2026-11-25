/**
 * Reading an agent answer: finding the JSON object in it and validating it.
 * See `ParseAgentEdits` in `../api/agent.ts`.
 */

import type { AgentEditKind, AgentParseError, AgentParseErrorCode, AgentParseResult } from "../api/agent.js";
import { MAX_ANSWER_LENGTH } from "./limits.js";
import { checkEnvelope } from "./shape.js";

function failure(code: AgentParseErrorCode, message: string, path: string | null = null): { ok: false; error: AgentParseError } {
  return { ok: false, error: { code, message, path } };
}

const FENCE = "```";

/**
 * The content of the first fenced code block that starts with `{`, or the
 * whole text when there is none.
 */
function jsonRegion(text: string): string {
  let from = 0;
  for (;;) {
    const open = text.indexOf(FENCE, from);
    if (open < 0) return text;
    const lineEnd = text.indexOf("\n", open + FENCE.length);
    if (lineEnd < 0) return text;
    const close = text.indexOf(FENCE, lineEnd + 1);
    if (close < 0) return text;
    const content = text.slice(lineEnd + 1, close);
    if (content.trimStart().startsWith("{")) return content;
    from = close + FENCE.length;
  }
}

type Extraction = { found: true; json: string } | { found: false; code: "no_json" | "invalid_json" };

/** The first balanced top-level `{…}` of the text. Braces inside strings do not count. */
function firstObject(text: string): Extraction {
  const start = text.indexOf("{");
  if (start < 0) return { found: false, code: "no_json" };
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 0x5c) i++;
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x7b) {
      depth++;
    } else if (code === 0x7d) {
      depth--;
      if (depth === 0) return { found: true, json: text.slice(start, i + 1) };
    }
  }
  return { found: false, code: "invalid_json" };
}

export const parseAgentEdits = (text: string, expectedKind?: AgentEditKind): AgentParseResult => {
  if (typeof text !== "string") return failure("no_json", "the answer is not text");
  if (text.length > MAX_ANSWER_LENGTH) return failure("too_large", "the answer is longer than 1 MiB");
  if (expectedKind !== undefined && expectedKind !== "docx" && expectedKind !== "sheet") {
    return failure("invalid_shape", "the expected kind is not a document kind", "kind");
  }
  const extraction = firstObject(jsonRegion(text));
  if (!extraction.found) {
    return extraction.code === "no_json"
      ? failure("no_json", "the answer holds no JSON object")
      : failure("invalid_json", "the JSON object in the answer is not closed");
  }
  let value: unknown;
  try {
    value = JSON.parse(extraction.json);
  } catch (error) {
    // The parser's own message can quote the input, which may be document text: it is not passed on.
    const kind = error instanceof SyntaxError ? "is not valid JSON" : "could not be read";
    return failure("invalid_json", `the object in the answer ${kind}`);
  }
  return checkEnvelope(value, expectedKind);
};
