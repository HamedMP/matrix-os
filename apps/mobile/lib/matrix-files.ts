import { z } from "zod/v4";
import type { GatewayClient } from "@/lib/gateway-client";

const FILES_ERROR = "Files unavailable. Try again.";
const SEARCH_ERROR = "Search unavailable. Try again.";

const MAX_NAME = 512;
const MAX_PATH = 4096;
const MAX_ENTRIES = 5000;
const MAX_SEARCH_RESULTS = 500;
const MAX_MATCHES = 50;
const MAX_PROJECTS = 500;

/** Default preview cap for owner file reads (~512KB). */
export const DEFAULT_TEXT_PREVIEW_BYTES = 512 * 1024;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

// Bounded projections of the gateway file-browser shapes. Unknown keys are
// stripped by default so newer gateways stay forward-compatible, while caps keep
// a hostile or malfunctioning gateway from returning unbounded payloads.
const FileTreeEntrySchema = z.object({
  name: z.string().min(1).max(MAX_NAME),
  type: z.enum(["file", "directory"]),
  size: z.number().nonnegative().optional(),
  gitStatus: z.string().max(64).nullable(),
  changedCount: z.number().nonnegative().optional(),
  modified: z.string().max(64).optional(),
  created: z.string().max(64).optional(),
  mime: z.string().max(128).optional(),
  children: z.number().nonnegative().optional(),
});

const FileListResponseSchema = z.object({
  path: z.string().max(MAX_PATH),
  entries: z.array(FileTreeEntrySchema).max(MAX_ENTRIES),
});

const SearchMatchSchema = z.object({
  line: z.number().nonnegative().optional(),
  text: z.string().max(512),
  type: z.enum(["name", "content"]),
});

const SearchResultEntrySchema = z.object({
  path: z.string().max(MAX_PATH),
  name: z.string().min(1).max(MAX_NAME),
  type: z.enum(["file", "directory"]),
  matches: z.array(SearchMatchSchema).max(MAX_MATCHES),
});

const SearchResponseSchema = z.object({
  query: z.string().max(512),
  results: z.array(SearchResultEntrySchema).max(MAX_SEARCH_RESULTS),
  truncated: z.boolean(),
});

const ProjectSchema = z.object({
  name: z.string().min(1).max(MAX_NAME),
  path: z.string().max(MAX_PATH),
  isGit: z.boolean(),
  branch: z.string().max(256).nullable(),
  dirtyCount: z.number().nonnegative(),
  modified: z.string().max(64).nullable(),
});

const ProjectsResponseSchema = z.object({
  root: z.string().max(MAX_PATH),
  projects: z.array(ProjectSchema).max(MAX_PROJECTS),
});

export type MatrixFileEntry = z.infer<typeof FileTreeEntrySchema>;
export type MatrixFileSearchMatch = z.infer<typeof SearchMatchSchema>;
export type MatrixFileSearchResult = z.infer<typeof SearchResultEntrySchema>;
export type MatrixProject = z.infer<typeof ProjectSchema>;

export type ListFilesResult =
  | { ok: true; path: string; entries: MatrixFileEntry[] }
  | { ok: false; error: typeof FILES_ERROR };

export type SearchFilesResult =
  | { ok: true; results: MatrixFileSearchResult[]; truncated: boolean }
  | { ok: false; error: typeof SEARCH_ERROR };

export type ListProjectsResult =
  | { ok: true; projects: MatrixProject[] }
  | { ok: false; error: typeof FILES_ERROR };

export type ReadTextFileResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; reason: "too-large" | "binary" | "unknown-size" | "unavailable"; size?: number };

function logFilesWarning(scope: string, detail: unknown): void {
  const reason = detail instanceof Error && detail.name === "AbortError" ? "aborted" : detail;
  console.warn(`[mobile] matrix files ${scope}`, reason instanceof Error ? reason.message : reason);
}

/**
 * Removes empty and `.` segments and rejects any `..` traversal. Returns the
 * cleaned relative path, or `null` when the path escapes the home root.
 */
export function normalizeRelPath(path: string): string | null {
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

export function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function parentPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

export function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs: { name: string; path: string }[] = [{ name: "Home", path: "" }];
  let acc = "";
  for (const segment of path.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${segment}` : segment;
    crumbs.push({ name: segment, path: acc });
  }
  return crumbs;
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}

/** Folders first, then files, each alphabetical (locale-aware, case-insensitive). */
export function sortEntries(entries: MatrixFileEntry[]): MatrixFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** Short relative age (e.g. "now", "5m", "3h", "2d") from an ISO timestamp. */
export function formatRelativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const elapsed = nowMs - timestamp;
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export async function listFiles(client: GatewayClient, path: string): Promise<ListFilesResult> {
  const safePath = normalizeRelPath(path);
  if (safePath === null) return { ok: false, error: FILES_ERROR };
  try {
    const res = await client.fetchOwnerFilesApi(`/api/files/list?path=${encodeURIComponent(safePath)}`);
    if (!res.ok) {
      logFilesWarning("list unavailable", `status ${res.status}`);
      return { ok: false, error: FILES_ERROR };
    }
    const parsed = FileListResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      logFilesWarning("list returned invalid payload", "invalid payload");
      return { ok: false, error: FILES_ERROR };
    }
    return { ok: true, path: parsed.data.path, entries: parsed.data.entries };
  } catch (err: unknown) {
    logFilesWarning("list unavailable", err);
    return { ok: false, error: FILES_ERROR };
  }
}

export async function searchFiles(
  client: GatewayClient,
  path: string,
  query: string,
): Promise<SearchFilesResult> {
  const safePath = normalizeRelPath(path);
  const trimmed = query.trim();
  if (safePath === null || trimmed.length === 0 || trimmed.length > 500) {
    return { ok: false, error: SEARCH_ERROR };
  }
  try {
    const params = new URLSearchParams({ path: safePath, q: trimmed });
    const res = await client.fetchOwnerFilesApi(`/api/files/search?${params.toString()}`);
    if (!res.ok) {
      logFilesWarning("search unavailable", `status ${res.status}`);
      return { ok: false, error: SEARCH_ERROR };
    }
    const parsed = SearchResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      logFilesWarning("search returned invalid payload", "invalid payload");
      return { ok: false, error: SEARCH_ERROR };
    }
    return { ok: true, results: parsed.data.results, truncated: parsed.data.truncated };
  } catch (err: unknown) {
    logFilesWarning("search unavailable", err);
    return { ok: false, error: SEARCH_ERROR };
  }
}

export async function listProjects(client: GatewayClient): Promise<ListProjectsResult> {
  try {
    const res = await client.fetchOwnerFilesApi("/api/projects");
    if (!res.ok) {
      logFilesWarning("projects unavailable", `status ${res.status}`);
      return { ok: false, error: FILES_ERROR };
    }
    const parsed = ProjectsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      logFilesWarning("projects returned invalid payload", "invalid payload");
      return { ok: false, error: FILES_ERROR };
    }
    return { ok: true, projects: parsed.data.projects };
  } catch (err: unknown) {
    logFilesWarning("projects unavailable", err);
    return { ok: false, error: FILES_ERROR };
  }
}

// Null byte or a high density of control characters marks content the text
// viewer should not render; keep the scan to a bounded prefix.
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (sample.length === 0) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true; // NUL byte: unambiguously binary
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / sample.length > 0.1;
}

export async function readTextFile(
  client: GatewayClient,
  path: string,
  maxBytes: number = DEFAULT_TEXT_PREVIEW_BYTES,
): Promise<ReadTextFileResult> {
  const safePath = normalizeRelPath(path);
  if (safePath === null || safePath.length === 0) return { ok: false, reason: "unavailable" };
  try {
    const res = await client.fetchOwnerHomeFile(safePath);
    if (!res.ok) {
      logFilesWarning("read unavailable", `status ${res.status}`);
      return { ok: false, reason: "unavailable" };
    }
    // React Native's fetch does not expose a readable `response.body` stream, so
    // there is no way to abort a download mid-body. Content-Length is the only
    // bound available before `res.text()` buffers the whole response, so refuse
    // to download a body whose size we cannot verify up front rather than risk
    // buffering an arbitrarily large response into memory.
    const declaredHeader = res.headers.get("content-length");
    if (declaredHeader === null || declaredHeader.trim().length === 0) {
      logFilesWarning("read missing content-length", "missing content-length");
      return { ok: false, reason: "unknown-size" };
    }
    const declared = Number(declaredHeader);
    if (!Number.isFinite(declared) || declared < 0) {
      logFilesWarning("read invalid content-length", "invalid content-length");
      return { ok: false, reason: "unknown-size" };
    }
    if (declared > maxBytes) {
      return { ok: false, reason: "too-large", size: declared };
    }
    const content = await res.text();
    // Defends against an understated Content-Length: each character is at least
    // one UTF-8 byte, so a char count over the cap is already over the byte cap;
    // avoids a full byte-length scan for large files.
    if (content.length > maxBytes) {
      return { ok: false, reason: "too-large", size: content.length };
    }
    if (looksBinary(content)) {
      return { ok: false, reason: "binary", size: content.length };
    }
    return { ok: true, content, truncated: false };
  } catch (err: unknown) {
    logFilesWarning("read unavailable", err);
    return { ok: false, reason: "unavailable" };
  }
}
