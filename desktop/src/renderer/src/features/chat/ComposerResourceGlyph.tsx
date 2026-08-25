import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import {
  AppWindow,
  Folder,
  FolderKanban,
  ListTodo,
  SquareTerminal,
} from "lucide-react";
import { FileGlyph, kindForEntry } from "../files/file-kind";

export function ComposerResourceGlyph({
  resource,
  size = 14,
}: {
  resource: CanonicalChatResourceReference;
  size?: number;
}) {
  if (resource.kind === "file") {
    const kind = kindForEntry({ name: resource.label, type: "file" });
    return (
      <span data-file-kind={kind} className="inline-flex">
        <FileGlyph kind={kind} size={size} />
      </span>
    );
  }
  if (resource.kind === "folder") {
    return <span data-file-kind="folder" className="inline-flex"><Folder size={size} aria-hidden /></span>;
  }
  if (resource.kind === "project") return <FolderKanban size={size} aria-hidden />;
  if (resource.kind === "task") return <ListTodo size={size} aria-hidden />;
  if (resource.kind === "app") return <AppWindow size={size} aria-hidden />;
  return <SquareTerminal size={size} aria-hidden />;
}
