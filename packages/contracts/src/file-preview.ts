import { z } from "zod/v4";
import {
  canonicalBoundedText,
  canonicalOwnerRelativePath,
  canonicalReferenceId,
} from "#canonical-chat-primitives";

const MimeTypeSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]*(?:;[\x20-\x7e]+)?$/);
const PreviewNameSchema = canonicalBoundedText(280, 1_120)
  .refine((value) => !/[\\/\u0000\r\n]/.test(value), "Preview name must be a file name");

export const FileResourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("home"),
    path: canonicalOwnerRelativePath(),
  }).strict(),
  z.object({
    kind: z.literal("project"),
    projectId: canonicalReferenceId(160),
    worktreeId: canonicalReferenceId(128).optional(),
    path: canonicalOwnerRelativePath(),
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    chatId: canonicalReferenceId(160),
    artifactId: canonicalReferenceId(160),
  }).strict(),
]);

export const PreviewKindSchema = z.enum([
  "image",
  "pdf",
  "text",
  "markdown",
  "table",
  "audio",
  "video",
  "html",
  "converted",
  "unsupported",
]);

export const FilePreviewDescriptorSchema = z.object({
  resource: FileResourceRefSchema,
  name: PreviewNameSchema,
  mimeType: MimeTypeSchema,
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  kind: PreviewKindSchema,
  version: canonicalReferenceId(200),
  canDownload: z.boolean(),
}).strict();

export type FileResourceRef = z.infer<typeof FileResourceRefSchema>;
export type PreviewKind = z.infer<typeof PreviewKindSchema>;
export type FilePreviewDescriptor = z.infer<typeof FilePreviewDescriptorSchema>;

const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "application/unknown",
  "binary/octet-stream",
]);

const EXTENSION_KINDS: Readonly<Record<string, PreviewKind>> = {
  apng: "image", avif: "image", bmp: "image", gif: "image", heic: "image",
  heif: "image", ico: "image", jpeg: "image", jpg: "image", png: "image",
  svg: "image", tif: "image", tiff: "image", webp: "image",
  pdf: "pdf",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  csv: "table", tsv: "table",
  aac: "audio", flac: "audio", m4a: "audio", mp3: "audio", oga: "audio",
  ogg: "audio", opus: "audio", wav: "audio",
  avi: "video", m4v: "video", mkv: "video", mov: "video", mp4: "video",
  ogv: "video", webm: "video",
  htm: "html", html: "html",
  c: "text", cc: "text", conf: "text", cpp: "text", css: "text", go: "text",
  h: "text", hpp: "text", ini: "text", java: "text", js: "text", json: "text",
  jsx: "text", log: "text", mjs: "text", py: "text", rb: "text", rs: "text",
  sh: "text", sql: "text", toml: "text", ts: "text", tsx: "text", txt: "text",
  xml: "text", yaml: "text", yml: "text",
};

function normalizedMimeType(mimeType: string | undefined): string {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function kindForSpecificMime(mimeType: string): PreviewKind {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") return "markdown";
  if (mimeType === "text/csv" || mimeType === "text/tab-separated-values" || mimeType === "application/csv") return "table";
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") return "html";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/javascript",
    "application/x-javascript",
  ].includes(mimeType) || mimeType.endsWith("+json") || mimeType.endsWith("+xml")) return "text";
  return "unsupported";
}

export function classifyFilePreview(input: { name: string; mimeType?: string }): PreviewKind {
  const mimeType = normalizedMimeType(input.mimeType);
  if (!GENERIC_MIME_TYPES.has(mimeType)) return kindForSpecificMime(mimeType);
  const cleanName = input.name.split(/[?#]/, 1)[0] ?? input.name;
  const dot = cleanName.lastIndexOf(".");
  if (dot < 0 || dot === cleanName.length - 1) return "unsupported";
  return EXTENSION_KINDS[cleanName.slice(dot + 1).toLowerCase()] ?? "unsupported";
}

export type ChatFileReferenceContext =
  | { root: "home"; baseDirectory: string }
  | { root: "project"; projectId: string; worktreeId?: string; baseDirectory: string };

function validRelativeSegments(value: string, allowEmpty = false): string[] | null {
  if (value === "" && allowEmpty) return [];
  if (value === "" || value.startsWith("/") || value.startsWith("~") || value.includes("\\") || value.includes("\0")) return null;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") ? parts : null;
}

export function normalizeChatFileReference(
  raw: string,
  context: ChatFileReferenceContext,
): FileResourceRef | null {
  if (raw.length > 4_096) return null;
  let value = raw.trim();
  if (value === "" || /^https?:\/\//i.test(value)) return null;
  try {
    value = decodeURIComponent(value);
  } catch (error: unknown) {
    if (error instanceof URIError) return null;
    throw error;
  }
  // Decode exactly once. A second encoded path delimiter/traversal token is
  // ambiguous and must not gain authority in a downstream layer.
  if (/%25(?:2e|2f|5c|3a)/i.test(raw) || /%(?:2e|2f|5c|3a)/i.test(value)) return null;
  value = value.replace(/#(?:L)?\d+(?:-L?\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
  if (value.includes("?") || value.includes("#")) return null;

  let forcedHome = false;
  if (/^file:\/\/\//i.test(value)) {
    value = value.replace(/^file:\/\/\/home\/matrix\/home\//i, "");
    if (/^file:/i.test(value)) return null;
    forcedHome = true;
  } else if (value.startsWith("/home/matrix/home/")) {
    value = value.slice("/home/matrix/home/".length);
    forcedHome = true;
  } else if (value.startsWith("~/")) {
    value = value.slice(2);
    forcedHome = true;
  } else if (value.startsWith("/files/")) {
    value = value.slice(7);
    forcedHome = true;
  } else if (value.startsWith("./")) {
    value = value.slice(2);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) {
    return null;
  }

  const relative = validRelativeSegments(value);
  if (!relative) return null;
  if (forcedHome) return FileResourceRefSchema.parse({ kind: "home", path: relative.join("/") });
  const base = validRelativeSegments(context.baseDirectory, true);
  if (!base) return null;
  const path = [...base, ...relative].join("/");
  const resource = context.root === "home"
    ? { kind: "home" as const, path }
    : {
        kind: "project" as const,
        projectId: context.projectId,
        ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
        path,
      };
  const parsed = FileResourceRefSchema.safeParse(resource);
  return parsed.success ? parsed.data : null;
}
