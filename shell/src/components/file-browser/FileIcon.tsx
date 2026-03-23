"use client";

import {
  FolderIcon,
  FileTextIcon,
  FileIcon as FileIconBase,
  ImageIcon,
  FilmIcon,
  MusicIcon,
  FileCodeIcon,
  FileJsonIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FileIconProps {
  name: string;
  type: "file" | "directory";
  selected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  renaming?: React.ReactNode;
}

function getFileIcon(name: string, type: "file" | "directory") {
  if (type === "directory") return FolderIcon;
  const ext = name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "";
  if ([".md", ".txt", ".log", ".csv"].includes(ext)) return FileTextIcon;
  if ([".json", ".yaml", ".yml", ".toml"].includes(ext)) return FileJsonIcon;
  if ([".js", ".ts", ".jsx", ".tsx", ".py", ".html", ".css", ".sh"].includes(ext)) return FileCodeIcon;
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return ImageIcon;
  if ([".mp4", ".webm"].includes(ext)) return FilmIcon;
  if ([".mp3", ".wav"].includes(ext)) return MusicIcon;
  return FileIconBase;
}

export function FileIcon({
  name,
  type,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  renaming,
}: FileIconProps) {
  const Icon = getFileIcon(name, type);

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1 p-2 rounded-lg cursor-default select-none w-24",
        "hover:bg-accent/50 transition-colors",
        selected && "bg-accent ring-1 ring-primary/30",
      )}
      role="gridcell"
      aria-selected={selected}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <Icon
        className={cn(
          "size-10 shrink-0",
          type === "directory" ? "text-blue-400" : "text-muted-foreground",
        )}
      />
      {renaming ?? (
        <span className="text-xs text-center truncate w-full" title={name}>
          {name}
        </span>
      )}
    </div>
  );
}
