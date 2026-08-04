// File-kind classification and the local lucide glyph for each kind. All
// icons are bundled vector glyphs — no remote images, no new dependencies.
import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileText,
  FileVideo,
  Folder,
  Image as ImageIcon,
} from "lucide-react";

export type FileKind =
  | "folder"
  | "image"
  | "code"
  | "document"
  | "archive"
  | "audio"
  | "video"
  | "generic";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "tiff"]);
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "css", "scss", "html", "htm",
  "py", "rs", "go", "java", "c", "cc", "cpp", "h", "hpp", "rb", "php", "swift",
  "kt", "sh", "bash", "zsh", "yml", "yaml", "toml", "xml", "sql", "vue", "svelte",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "md", "mdx", "txt", "rtf", "pdf", "doc", "docx", "odt", "pages", "numbers",
  "key", "xls", "xlsx", "csv", "ppt", "pptx",
]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "pkg", "iso"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v"]);

function extensionOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  // Dotfiles (".gitignore") have no extension; "archive.tar.gz" classifies by
  // its final segment, which matches how Finder treats compound names.
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function kindForEntry(entry: { name: string; type: "file" | "directory" }): FileKind {
  if (entry.type === "directory") return "folder";
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "generic";
}

const GLYPHS: Record<FileKind, typeof File> = {
  folder: Folder,
  image: ImageIcon,
  code: FileCode2,
  document: FileText,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  generic: File,
};

// Decorative glyph: the accessible name of an entry comes from its row/tile
// button label, so the icon itself stays out of the accessibility tree.
export function FileGlyph({ kind, size = 16 }: { kind: FileKind; size?: number }) {
  const Icon = GLYPHS[kind];
  return <Icon size={size} aria-hidden />;
}
