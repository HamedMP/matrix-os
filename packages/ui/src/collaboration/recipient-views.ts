/**
 * Spec 535 D6 (FR-025): every shareable kind opens in its own recipient view.
 * Accept and open actions dispatch through `openSharedResource`, which never
 * falls back to Chat: a surface without a view for a kind says so instead.
 */
import { CollaborationDirectError } from "./direct-client.js";

export type SharedResourceKind = "chat" | "terminal" | "project" | "file" | "folder" | "app";

export interface SharedResourceOpeners {
  openChat(scopeId: string, chatId?: string, title?: string): void;
  openTerminal(scopeId: string): void;
  openProject(scopeId: string): void;
  /** Optional until every surface has the view; a missing opener hides the Open action. */
  openFile?(scopeId: string): void;
  openFolder?(scopeId: string): void;
  openApp?(scopeId: string): void;
}

function openerFor(kind: SharedResourceKind, openers: SharedResourceOpeners): ((scopeId: string) => void) | undefined {
  switch (kind) {
    case "chat": return openers.openChat;
    case "terminal": return openers.openTerminal;
    case "project": return openers.openProject;
    case "file": return openers.openFile;
    case "folder": return openers.openFolder;
    case "app": return openers.openApp;
  }
}

export function canOpenSharedResource(kind: SharedResourceKind, openers: SharedResourceOpeners): boolean {
  return openerFor(kind, openers) !== undefined;
}

/** Opens `scopeId` in the view for `kind`; returns false when this surface has no such view. */
export function openSharedResource(kind: SharedResourceKind, scopeId: string, openers: SharedResourceOpeners): boolean {
  const open = openerFor(kind, openers);
  if (!open) return false;
  open(scopeId);
  return true;
}

/** What an invitation to each kind grants, keeps private, and lets each role do. */
export function sharedResourceInvitationCopy(kind: SharedResourceKind): { grants: string; private: string; roles: string } {
  switch (kind) {
    case "terminal": return {
      grants: "Access to this terminal’s retained and live output, with input control when your role permits.",
      private: "This does not include its project, sibling Chats or terminals, files, apps, or anyone’s private state.",
      roles: "Owners and editors can request input control. Viewers watch only, and no role can create sibling terminals from this share.",
    };
    case "project": return {
      grants: "Access to the complete project inventory, including future project-owned contents.",
      private: "External references, personal presentation state, credentials, and unrelated resources stay private.",
      roles: "Editors can discuss and request AI. Viewers remain read-only. Owners decide any AI approvals.",
    };
    case "file": return {
      grants: "Access to this file: preview and download, with editing when your role permits.",
      private: "This does not include the folder around it, other files, apps, or anyone’s private state.",
      roles: "Contributors can edit the file. Viewers can preview and download it.",
    };
    case "folder": return {
      grants: "Access to this folder and the files inside it, with changes when your role permits.",
      private: "This does not include files outside the folder, apps, or anyone’s private state.",
      roles: "Contributors can add, rename and edit files. Viewers can browse and download.",
    };
    case "app": return {
      grants: "Access to this app instance and its data, with changes when your role permits.",
      private: "This does not include other apps, files, or anyone’s private state.",
      roles: "Contributors can use the app’s actions. Viewers can open it read-only.",
    };
    case "chat": return {
      grants: "Access to this ongoing Chat’s history, human discussion, and its ordered AI queue when shared AI is available.",
      private: "This does not include its project, sibling Chats or terminals, files, apps, or anyone’s private state.",
      roles: "Editors can discuss and request AI. Viewers remain read-only. Owners decide any AI approvals.",
    };
  }
}

/** Largest file shown as a text preview. */
export const SHARED_FILE_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Largest download a client holds in memory; the platform relay caps responses at the same size. */
export const SHARED_FILE_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;
/** Inline edits travel as one JSON write action (`COLLABORATION_INLINE_CONTENT_BYTES`). */
export const SHARED_FILE_EDIT_MAX_BYTES = 64 * 1024;

/**
 * Why a shared file cannot be shown. `resource_missing` is set by the view when
 * an authorized scope no longer reaches its file. Spec 535 B1b adds `paused`
 * (home `423 paused`) here; the view renders it as its own state.
 */
export type SharedFileUnavailableReason = "access_removed" | "host_offline" | "resource_missing" | "unavailable";

export function sharedFileFailureCode(error: unknown): CollaborationDirectError["code"] | null {
  const cause = error instanceof CollaborationDirectError ? error : error instanceof Error ? error.cause : undefined;
  return cause instanceof CollaborationDirectError ? cause.code : null;
}

export function classifySharedFileFailure(error: unknown): Exclude<SharedFileUnavailableReason, "resource_missing"> {
  const code = sharedFileFailureCode(error);
  if (code === "host_offline") return "host_offline";
  if (code === "not_found" || code === "denied") return "access_removed";
  return "unavailable";
}

/** Text detection for previews: a declared text type, or UTF-8 without NUL bytes in the first 8 KiB. */
export function decodeSharedFileText(bytes: Uint8Array, contentType: string): string | null {
  const textual = contentType.startsWith("text/") || /(?:json|xml|yaml|javascript|typescript|csv|markdown)$/.test(contentType);
  const sample = bytes.subarray(0, 8 * 1024);
  if (sample.includes(0)) return null;
  if (!textual && contentType !== "application/octet-stream") return null;
  try {
    return new TextDecoder("utf-8", { fatal: !textual }).decode(bytes);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[shared-file] text decode failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export function sharedFileName(path: string): string {
  return path.split("/").at(-1) || "file";
}

/** `notes.md` becomes `notes (my version).md`; used for the conflict copy a Contributor keeps. */
export function sharedFileCopyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (my version)${name.slice(dot)}` : `${name} (my version)`;
}
