const DRAFT_PREFIX = "matrix:collaboration:draft:v1:";
const DRAFT_INDEX_KEY = "matrix:collaboration:draft-index:v1";
const MAX_DRAFTS = 20;
const MAX_DRAFT_BYTES = 64 * 1024;

interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface DraftIdentity {
  actorId: string | null | undefined;
  scopeId: string;
  chatId: string;
}

interface DraftInput extends DraftIdentity {
  text: string;
}

function draftKey(identity: DraftIdentity): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(identity.actorId ?? "unknown")}:${encodeURIComponent(identity.scopeId)}:${encodeURIComponent(identity.chatId)}`;
}

async function readIndex(storage: DraftStorage): Promise<string[]> {
  const raw = await storage.getItem(DRAFT_INDEX_KEY);
  if (!raw || raw.length > 32 * 1024) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.startsWith(DRAFT_PREFIX)).slice(-MAX_DRAFTS);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[mobile-collaboration] draft index parsing failed", error instanceof Error ? error.name : "UnknownError");
    }
    return [];
  }
}

function truncateUtf8(value: string): string {
  if (new TextEncoder().encode(value).byteLength <= MAX_DRAFT_BYTES) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (new TextEncoder().encode(value.slice(0, middle)).byteLength <= MAX_DRAFT_BYTES) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

export async function loadCollaborationDraft(storage: DraftStorage, identity: DraftIdentity): Promise<string> {
  return await storage.getItem(draftKey(identity)) ?? "";
}

export async function saveCollaborationDraft(storage: DraftStorage, input: DraftInput): Promise<void> {
  const key = draftKey(input);
  const index = (await readIndex(storage)).filter((candidate) => candidate !== key);
  if (!input.text) {
    await storage.removeItem(key);
    await storage.setItem(DRAFT_INDEX_KEY, JSON.stringify(index));
    return;
  }
  index.push(key);
  const evicted = index.splice(0, Math.max(0, index.length - MAX_DRAFTS));
  await storage.setItem(key, truncateUtf8(input.text));
  await Promise.all(evicted.map(async (candidate) => storage.removeItem(candidate)));
  await storage.setItem(DRAFT_INDEX_KEY, JSON.stringify(index));
}
