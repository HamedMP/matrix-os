import { File, FileArchive, FileAudio, FileCode, FileText, FileVideo, Folder, FolderLock, Image, type LucideIcon } from "lucide-react";
import { Icon, type IconSize } from "../../../design/ds";
import { dsCn as cn } from "../../../design/ds";
import { kindForEntry, type FileKind } from "../file-kind";
import { tileToneForFile, tileToneForFolder, type FolderAccess, type TileTone } from "./file-presentation";

const GLYPHS: Record<FileKind, LucideIcon> = {
  folder: Folder,
  image: Image,
  code: FileCode,
  document: FileText,
  archive: FileArchive,
  audio: FileAudio,
  video: FileVideo,
  generic: File,
};

const TONE_CLASS: Record<TileTone, string> = {
  neutral: "border-ds-tint-neutral-border bg-ds-tint-neutral-fill text-ds-tint-neutral-text",
  info: "border-ds-tint-info-border bg-ds-tint-info-fill text-ds-tint-info-text",
  warning: "border-ds-tint-warning-border bg-ds-tint-warning-fill text-ds-tint-warning-text",
  destructive: "border-ds-tint-destructive-border bg-ds-tint-destructive-fill text-ds-tint-destructive-text",
};

const TILE_SIZE = { 32: { box: "size-8 rounded-md", icon: "sm" }, 40: { box: "size-10 rounded-md", icon: "md" }, 48: { box: "size-12 rounded-lg", icon: "lg" } } as const satisfies Record<number, { box: string; icon: IconSize }>;

/** Tinted square that carries a file's or folder's type icon. Decorative: the entry's label names it. */
export function FileTile({
  entry,
  access = "own",
  size = 32,
  className,
}: {
  entry: { name: string; type: "file" | "directory" };
  access?: FolderAccess;
  size?: keyof typeof TILE_SIZE;
  className?: string;
}) {
  const folder = entry.type === "directory";
  const tone = folder ? tileToneForFolder(access) : tileToneForFile(entry);
  const glyph = folder && access === "managed" ? FolderLock : GLYPHS[kindForEntry(entry)];
  const dims = TILE_SIZE[size];
  return (
    <span aria-hidden="true" data-tone={tone} className={cn("flex shrink-0 items-center justify-center border", dims.box, TONE_CLASS[tone], className)}>
      <Icon icon={glyph} size={dims.icon} />
    </span>
  );
}
