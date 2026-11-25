/**
 * Defensive JSON reading for model replies: finds the first JSON object or
 * array in the text, then repairs the usual damage (code fences, prose
 * around it, smart quotes, trailing commas, raw line breaks inside strings,
 * a reply cut off before its closing brackets). Never evaluates anything.
 */

export type LooseJsonResult = { ok: true; value: unknown } | { ok: false };

const MAX_DEPTH = 64;

function tryParse(text: string): LooseJsonResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return { ok: false };
    throw error;
  }
}

/** Straight quotes for the curly ones models sometimes emit around keys and values. */
function straightenQuotes(text: string): string {
  return text.replace(/[“”„‟″]/g, '"');
}

/**
 * Walks from the first `{` or `[`, tracking strings, and returns the value's
 * text with raw line breaks in strings escaped, trailing commas removed and
 * missing closers appended. Null when no structure starts.
 */
function extractAndRepair(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
      } else if (char === "\\") {
        escaped = true;
        out += char;
      } else if (char === '"') {
        inString = false;
        out += char;
      } else if (char === "\n") out += "\\n";
      else if (char === "\r") out += "\\r";
      else if (char === "\t") out += "\\t";
      else out += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "{" || char === "[") {
      if (stack.length >= MAX_DEPTH) return null;
      stack.push(char === "{" ? "}" : "]");
      out += char;
    } else if (char === "}" || char === "]") {
      if (stack[stack.length - 1] !== char) return null;
      stack.pop();
      out = out.replace(/,\s*$/, "") + char;
      if (stack.length === 0) return out;
    } else out += char;
  }
  // Cut off: close the open string, drop a dangling key or comma, close the brackets.
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/,\s*$/, "").replace(/,\s*"[^"]*"\s*:?\s*$/, (match) => (match.includes(":") ? "" : match));
  out = out.replace(/:\s*$/, ": null");
  while (stack.length) out += stack.pop();
  return out;
}

export function parseLooseJson(text: string): LooseJsonResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false };
  const direct = tryParse(text.trim());
  if (direct.ok && typeof direct.value === "object" && direct.value !== null) return direct;
  const unfenced = text.replace(/```(?:json|JSON)?/g, "");
  for (const candidate of [unfenced, straightenQuotes(unfenced)]) {
    const repaired = extractAndRepair(candidate);
    if (repaired === null) continue;
    const parsed = tryParse(repaired);
    if (parsed.ok) return parsed;
  }
  return { ok: false };
}
