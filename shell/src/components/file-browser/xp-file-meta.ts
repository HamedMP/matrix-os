import type { FileEntry } from "@/hooks/useFileBrowser";

/** XP Explorer-style type labels: "File Folder", "TXT File", "File". */
export function xpTypeLabel(entry: FileEntry): string {
  if (entry.type === "directory") return "File Folder";
  const ext = entry.name.includes(".")
    ? entry.name.split(".").pop()!.toUpperCase()
    : "";
  return ext ? `${ext} File` : "File";
}

export function formatXpSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Color of the app mark on the white-page file glyph, by file kind. */
export function xpFileMarkColor(name: string): string {
  const ext = name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "#3aa655";
  if ([".js", ".ts", ".jsx", ".tsx", ".py", ".html", ".css", ".sh"].includes(ext)) return "#3a93ff";
  if ([".json", ".yaml", ".yml", ".toml"].includes(ext)) return "#e0a030";
  if ([".mp3", ".wav"].includes(ext)) return "#b05ab0";
  if ([".mp4", ".webm"].includes(ext)) return "#c0504d";
  if ([".md", ".txt", ".log", ".csv"].includes(ext)) return "#33689c";
  return "#7f9db9";
}
