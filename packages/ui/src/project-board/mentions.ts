/** `@handle` helpers for the task comment composer. Handles are letters, digits, `.`, `_` and `-`. */

const HANDLE_CHAR = /[A-Za-z0-9._-]/;
const MAX_HANDLE_LENGTH = 40;

/** The mention being typed at the caret, if any: an `@` at a word start followed by handle characters. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  let index = caret - 1;
  while (index >= 0 && caret - index <= MAX_HANDLE_LENGTH && HANDLE_CHAR.test(text[index]!)) index -= 1;
  if (index < 0 || text[index] !== "@") return null;
  const before = index > 0 ? text[index - 1]! : "";
  if (before && !/[\s([{"'“]/.test(before)) return null;
  return { start: index, query: text.slice(index + 1, caret) };
}

export function insertMention(text: string, start: number, caret: number, handle: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = `@${handle}${after.startsWith(" ") ? "" : " "}`;
  const next = text.slice(0, start) + insert + after;
  return { text: next, caret: start + insert.length + (after.startsWith(" ") ? 1 : 0) };
}

/** Known handles mentioned in `body`, in first-mention order, each once. */
export function mentionedHandles(body: string, handles: readonly string[]): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/(^|[\s([{"'“])@([A-Za-z0-9._-]{1,40})/g)) {
    const handle = match[2]!.replace(/[.,]+$/, "");
    if (handles.includes(handle) && !found.includes(handle)) found.push(handle);
  }
  return found;
}
