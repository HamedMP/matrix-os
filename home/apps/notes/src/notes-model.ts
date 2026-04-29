export interface Note {
  id: string;
  title: string;
  content: string;
  content_json: TiptapDoc;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  tags: string[];
  preview: string;
}

export interface TiptapNode {
  type?: string;
  text?: string;
  content?: TiptapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  attrs?: Record<string, any>;
}

export interface TiptapDoc {
  type: "doc";
  content?: TiptapNode[];
}

export interface NoteInput {
  id?: string;
  title?: string | null;
  content?: string | null;
  content_json?: TiptapDoc | null;
  pinned?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
}

let sequence = 0;

function nextIsoTimestamp(): string {
  sequence += 1;
  return new Date(Date.now() + sequence).toISOString();
}

function fallbackId(): string {
  return `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyTiptapDoc(): TiptapDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function isTiptapNode(value: unknown): value is TiptapNode {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isTiptapDoc(value: unknown): value is TiptapDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TiptapDoc>;
  return candidate.type === "doc" && (candidate.content === undefined || Array.isArray(candidate.content));
}

export function tiptapDocToText(doc: TiptapDoc): string {
  const parts: string[] = [];

  function visit(node: TiptapNode): void {
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (isTiptapNode(child)) visit(child);
      }
    }
    if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem") {
      parts.push(" ");
    }
  }

  for (const node of doc.content ?? []) {
    if (isTiptapNode(node)) visit(node);
  }

  return parts.join("").replace(/\s+/g, " ").trim();
}

export function extractTags(content: string): string[] {
  const tags: string[] = [];
  const matches = content.matchAll(/(^|[\s([{])#([a-zA-Z][a-zA-Z0-9-]{1,40})\b/g);
  for (const match of matches) {
    const tag = match[2].toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

export function buildNotePreview(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function createNote(input: NoteInput = {}): Note {
  const now = input.updated_at ?? input.created_at ?? nextIsoTimestamp();
  const content = input.content ?? "";
  const contentJson = input.content_json && isTiptapDoc(input.content_json)
    ? input.content_json
    : emptyTiptapDoc();
  const searchableText = [content, tiptapDocToText(contentJson)].join(" ");
  return {
    id: input.id ?? globalThis.crypto?.randomUUID?.() ?? fallbackId(),
    title: (input.title ?? "").trim() || "Untitled",
    content,
    content_json: contentJson,
    pinned: Boolean(input.pinned),
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    tags: extractTags(searchableText),
    preview: buildNotePreview(searchableText) || "No content yet",
  };
}

export function hydrateNote(row: Record<string, unknown>): Note {
  const contentJson = isTiptapDoc(row.content_json) ? row.content_json : null;
  return createNote({
    id: typeof row.id === "string" ? row.id : undefined,
    title: typeof row.title === "string" ? row.title : "Untitled",
    content: typeof row.content === "string" ? row.content : "",
    content_json: contentJson,
    pinned: typeof row.pinned === "boolean" ? row.pinned : false,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  });
}

export function filterNotes(notes: Note[], query: string, activeTag = "all"): Note[] {
  const normalized = query.trim().toLowerCase();
  return notes
    .filter((note) => {
      const tagMatch = activeTag === "all" || note.tags.includes(activeTag);
      if (!tagMatch) return false;
      if (!normalized) return true;
      const haystack = [
        note.title,
        note.content,
        note.preview,
        ...note.tags,
      ].join(" ").toLowerCase();
      return haystack.includes(normalized);
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
}

export function collectTags(notes: Note[]): string[] {
  return notes
    .flatMap((note) => note.tags)
    .reduce<string[]>((tags, tag) => (tags.includes(tag) ? tags : [...tags, tag]), [])
    .sort((a, b) => a.localeCompare(b));
}
