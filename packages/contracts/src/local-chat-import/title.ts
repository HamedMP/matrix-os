import type { ImportHarness } from "#local-chat-import/types";

/** Recognize only complete Claude command envelopes used as automatic title hints. */
export function isLocalChatTitleMetadata(harness: ImportHarness, text: string | undefined): boolean {
  if (harness !== "claude" || typeof text !== "string") return false;
  let remaining = text.trim();
  const name = remaining.match(/^<command-name>(\/[A-Za-z0-9_:-]{1,128})<\/command-name>/);
  if (!name) return false;
  remaining = remaining.slice(name[0].length).trim();
  for (const tag of ["command-message", "command-args"]) {
    const opening = `<${tag}>`;
    if (!remaining.startsWith(opening)) continue;
    const closing = `</${tag}>`;
    const end = remaining.indexOf(closing, opening.length);
    if (end < 0) return false;
    remaining = remaining.slice(end + closing.length).trim();
  }
  return remaining.length === 0;
}
