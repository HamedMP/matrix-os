const PREFIX = "matrix:collaboration:discussion-draft:v1";
const MAX_DRAFT_BYTES = 16 * 1024;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function removeDraft(storage: Pick<Storage, "removeItem">, key: string): void {
  try {
    storage.removeItem(key);
  } catch (error: unknown) {
    console.warn("[collaboration-discussion] draft cleanup unavailable", errorKind(error));
  }
}

function truncateUtf8(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= MAX_DRAFT_BYTES) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= MAX_DRAFT_BYTES) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

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
      } catch (error: unknown) {
        console.warn("[collaboration-discussion] invalid draft discarded", errorKind(error));
        removeDraft(storage, key);
        return "";
      }
    },
    save(key: string, text: string): void {
      if (!storage) return;
      const bounded = truncateUtf8(text);
      try {
        storage.setItem(key, JSON.stringify({ text: bounded }));
      } catch (error: unknown) {
        console.warn("[collaboration-discussion] draft persistence unavailable", errorKind(error));
      }
    },
    clear(key: string): void {
      if (storage) removeDraft(storage, key);
    },
  };
}
