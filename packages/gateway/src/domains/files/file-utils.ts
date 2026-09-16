import { extname } from "node:path";

const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".jsx": "text/jsx",
  ".tsx": "text/tsx",
  ".py": "text/x-python",
  ".html": "text/html",
  ".css": "text/css",
  ".sh": "text/x-shellscript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const TEXT_EXTENSIONS = new Set(
  Object.entries(MIME_MAP)
    .filter(([, mime]) => mime.startsWith("text/") || mime === "application/json")
    .map(([ext]) => ext),
);

const BINARY_EXTENSIONS = new Set(
  Object.entries(MIME_MAP)
    .filter(
      ([, mime]) =>
        mime.startsWith("image/") ||
        mime.startsWith("audio/") ||
        mime.startsWith("video/") ||
        mime === "application/pdf",
    )
    .map(([ext]) => ext),
);

export function getMimeType(extOrFilename: string): string {
  const ext = extOrFilename.startsWith(".")
    ? extOrFilename.toLowerCase()
    : `.${extOrFilename.toLowerCase()}`;
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export function isTextFile(filename: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filename).toLowerCase());
}

export function isBinaryFile(filename: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filename).toLowerCase());
}
