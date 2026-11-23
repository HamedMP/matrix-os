// Project row management shared by Electron Desktop and the web OS views:
// the action list, its copy, and the Files location contract.
import { UsersIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { FolderOpen, PinIcon, PinOffIcon, Settings, Trash2 } from "lucide-react";
import type { ProjectMenuAction } from "./ProjectActionsMenu.js";

export const PROJECT_UPDATE_FAILED = "The project could not be updated. Try again.";
export const PROJECT_FOLDER_OPEN_FAILED = "The project folder could not be opened. Try again.";

/** A Matrix-home-relative folder path, or null for anything absolute, escaping, or malformed. */
export function parseProjectFilesLocation(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return null;
  return value.split("/").some(part => !part || part === "." || part === "..") ? null : value;
}

/** Whole-project sharing entry; absent until collaboration for the computer is resolved. */
export function projectShareMenuItem(sharing: { organizationId: string | null } | null, onShare: (() => void) | undefined): ProjectMenuAction[] {
  if (!sharing || !onShare) return [];
  return [{
    label: sharing.organizationId ? "Share project" : "Loading sharing…",
    icon: <HugeiconsIcon icon={UsersIcon} size={16} strokeWidth={1.5} aria-hidden />,
    disabled: !sharing.organizationId,
    onSelect: onShare,
  }];
}

/** The project row actions in Electron Desktop order. */
export function projectManagementMenuItems({ pinned, available, filesAvailable = available, pending, onTogglePin, onEdit, onShowInFiles, share = [], onDelete }: {
  pinned: boolean; available: boolean; pending: boolean;
  /** Defaults to `available`; an OS view may lack a Files surface for this computer. */
  filesAvailable?: boolean;
  onTogglePin(): void; onEdit(): void; onShowInFiles(): void; share?: ProjectMenuAction[]; onDelete(): void;
}): ProjectMenuAction[] {
  const blocked = !available || pending;
  return [
    { label: pinned ? "Unpin" : "Pin", icon: pinned ? <PinOffIcon size={16} aria-hidden /> : <PinIcon size={16} aria-hidden />, disabled: blocked, onSelect: onTogglePin },
    { label: "Edit", icon: <Settings size={16} aria-hidden />, disabled: blocked, onSelect: onEdit },
    { label: "Show in Files", icon: <FolderOpen size={16} aria-hidden />, disabled: !filesAvailable || pending, onSelect: onShowInFiles },
    ...share,
    { label: "Delete project", icon: <Trash2 size={16} aria-hidden />, danger: true, disabled: pending, onSelect: onDelete },
  ];
}

