import { basename, extname } from "node:path";

const MAX_ARTIFACTS_PER_ITEM = 8;
const MAX_INLINE_BASE64_CHARS = 12 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,119}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MIME_BY_EXTENSION = Object.freeze({
  ".aac": "audio/aac", ".csv": "text/csv", ".gif": "image/gif", ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg", ".m4a": "audio/mp4", ".md": "text/markdown", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".oga": "audio/ogg", ".ogg": "audio/ogg",
  ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".tsv": "text/tab-separated-values",
  ".txt": "text/plain", ".wav": "audio/wav", ".webm": "video/webm", ".webp": "image/webp",
});

function safeMime(value) {
  if (typeof value !== "string") return undefined;
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  return SAFE_MIME.test(mime) ? mime : undefined;
}

function fileSource(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  let path = value;
  if (value.startsWith("file://")) {
    try {
      const url = new URL(value);
      if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) return null;
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/") || path.includes("\0") || /[\r\n]/.test(path)) return null;
  return { type: "run_file", path };
}

function dataSource(value, hintedMime) {
  if (typeof value !== "string") return null;
  const match = /^data:([^;,]{1,120});base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) return null;
  const mimeType = safeMime(match[1]) ?? safeMime(hintedMime);
  const base64 = match[2];
  if (!mimeType || base64.length === 0 || base64.length > MAX_INLINE_BASE64_CHARS || !BASE64.test(base64)) return null;
  return { type: "inline_bytes", mimeType, base64 };
}

function inlineSource(base64, mimeType) {
  const safeType = safeMime(mimeType);
  if (typeof base64 !== "string" || !safeType || base64.length === 0
    || base64.length > MAX_INLINE_BASE64_CHARS || !BASE64.test(base64)) return null;
  return { type: "inline_bytes", mimeType: safeType, base64 };
}

function sourceFromUrl(value, hintedMime) {
  return dataSource(value, hintedMime) ?? fileSource(value);
}

function labelFor(source, mimeType, index, preferred) {
  if (typeof preferred === "string" && preferred.length > 0 && preferred.length <= 280
    && !/[\\/\u0000\r\n]/.test(preferred)) return preferred;
  if (source.type === "run_file") {
    const label = basename(source.path);
    if (label.length > 0 && label.length <= 280 && !/[\u0000\r\n]/.test(label)) return label;
  }
  const extension = Object.entries(MIME_BY_EXTENSION).find(([, value]) => value === mimeType)?.[0] ?? ".bin";
  const prefix = mimeType.startsWith("image/") ? "image"
    : mimeType.startsWith("audio/") ? "audio"
      : mimeType.startsWith("video/") ? "video" : "resource";
  return `${prefix}-${index + 1}${extension}`;
}

function record(itemId, outputIndex, source, mimeType, preferredLabel) {
  const resolvedMime = safeMime(mimeType)
    ?? (source.type === "inline_bytes" ? source.mimeType : MIME_BY_EXTENSION[extname(source.path).toLowerCase()])
    ?? "application/octet-stream";
  return {
    type: "matrix.codex.artifact.available",
    providerItemId: itemId,
    outputIndex,
    source,
    label: labelFor(source, resolvedMime, outputIndex, preferredLabel),
    mimeType: resolvedMime,
  };
}

function contentRecord(itemId, content, index) {
  if (!content || typeof content !== "object") return null;
  if (content.type === "input_image" || content.type === "inputImage") {
    const value = content.image_url ?? content.imageUrl;
    const source = sourceFromUrl(value, "image/png");
    return source ? record(itemId, index, source, source.mimeType ?? "image/png") : null;
  }
  if (content.type === "input_audio" || content.type === "inputAudio") {
    const value = content.audio_url ?? content.audioUrl;
    const source = sourceFromUrl(value, "audio/mpeg");
    return source ? record(itemId, index, source, source.mimeType ?? "audio/mpeg") : null;
  }
  if (content.type === "image" || content.type === "audio") {
    const source = inlineSource(content.data, content.mimeType);
    return source ? record(itemId, index, source, source.mimeType) : null;
  }
  if (content.type === "resource" && content.resource && typeof content.resource === "object") {
    const resource = content.resource;
    const mimeType = safeMime(resource.mimeType) ?? "application/octet-stream";
    const source = inlineSource(resource.blob, mimeType)
      ?? (typeof resource.text === "string" && resource.text.length <= 512 * 1024
        ? inlineSource(Buffer.from(resource.text, "utf8").toString("base64"), mimeType === "application/octet-stream" ? "text/plain" : mimeType)
        : null)
      ?? fileSource(resource.uri);
    return source ? record(itemId, index, source, source.mimeType ?? mimeType) : null;
  }
  if (content.type === "resource_link") {
    const source = fileSource(content.uri);
    return source ? record(itemId, index, source, content.mimeType, content.name) : null;
  }
  return null;
}

export function extractCodexArtifactRecords(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !SAFE_ID.test(item.id)) return [];
  if (item.type === "imageGeneration") {
    if (item.status !== "completed" || item.failure) return [];
    const source = fileSource(item.savedPath) ?? dataSource(item.result, "image/png");
    return source ? [record(item.id, 0, source, source.mimeType ?? "image/png")] : [];
  }
  if (item.type === "imageView") {
    const source = fileSource(item.path);
    return source ? [record(item.id, 0, source, MIME_BY_EXTENSION[extname(source.path).toLowerCase()] ?? "image/png")] : [];
  }
  let content = null;
  if (item.type === "functionCallOutput" && Array.isArray(item.output)) content = item.output;
  if (item.type === "dynamicToolCall" && Array.isArray(item.contentItems)) content = item.contentItems;
  if (item.type === "mcpToolCall" && item.result && typeof item.result === "object" && Array.isArray(item.result.content)) {
    content = item.result.content;
  }
  if (!content) return [];
  return content.slice(0, MAX_ARTIFACTS_PER_ITEM)
    .map((entry, index) => contentRecord(item.id, entry, index))
    .filter((entry) => entry !== null);
}
