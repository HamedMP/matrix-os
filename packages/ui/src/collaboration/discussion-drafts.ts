const PREFIX = "matrix:collaboration:discussion-draft:v1";
const MAX_DRAFT_BYTES = 16 * 1024;

export function discussionDraftKey(input: {
  actorId: string;
  runtimeId: string;
  scopeId: string;
}): string {
  return `${PREFIX}:${encodeURIComponent(input.actorId)}:${encodeURIComponent(input.runtimeId)}:${encodeURIComponent(input.scopeId)}`;
}

export function createDiscussionDraftStore(
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  return {
    load(key: string): string {
      if (!storage) return "";
      try {
        const value = storage.getItem(key);
        if (!value) return "";
        const parsed = JSON.parse(value) as { text?: unknown };
        return typeof parsed.text === "string" && new TextEncoder().encode(parsed.text).byteLength <= MAX_DRAFT_BYTES
          ? parsed.text
          : "";
      } catch {
        storage.removeItem(key);
        return "";
      }
    },
    save(key: string, text: string): void {
      if (!storage) return;
      const bounded = new TextEncoder().encode(text).byteLength <= MAX_DRAFT_BYTES ? text : text.slice(0, 8_192);
      try {
        storage.setItem(key, JSON.stringify({ text: bounded }));
      } catch (error: unknown) {
        console.warn("[collaboration-discussion] draft persistence unavailable", error instanceof Error ? error.name : "UnknownError");
      }
    },
    clear(key: string): void {
      try { storage?.removeItem(key); } catch { /* best-effort personal state */ }
    },
  };
}
