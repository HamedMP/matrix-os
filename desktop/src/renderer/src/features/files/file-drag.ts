import { MatrixComputerRuntimeSlotSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  OwnerDirectoryPathSchema,
  OwnerRelativePathSchema,
} from "./file-management-contracts";
import { beginFileDrag, type FileSelectionState } from "./file-selection";

export const FILE_MOVE_MIME = "application/x-matrix-os-file-move+json";
export const MAX_FILE_DRAG_BYTES = 128 * 1_024;

const FileDragScopeSchema = z.object({
  directory: OwnerDirectoryPathSchema,
  runtimeSlot: MatrixComputerRuntimeSlotSchema,
  authGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const FileDragPayloadSchema = z.object({
  version: z.literal(1),
  paths: z.array(OwnerRelativePathSchema).min(1).max(100),
  scope: FileDragScopeSchema,
}).strict().refine((payload) => new Set(payload.paths).size === payload.paths.length)
  .refine((payload) => payload.paths.every((path) => parentDirectory(path) === payload.scope.directory));

export type FileDragPayload = z.infer<typeof FileDragPayloadSchema>;
export interface FileDragSession {
  selection: FileSelectionState;
  paths: string[];
  preview: { label: string; additionalCount: number };
}

export function mountFileDragPreview(
  document: Document,
  preview: FileDragSession["preview"],
): { element: HTMLDivElement; cleanup(): void } {
  document.querySelectorAll("[data-file-drag-preview]").forEach((node) => node.remove());
  const element = document.createElement("div");
  element.dataset.fileDragPreview = "true";
  element.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:-10000px",
    "pointer-events:none",
    "padding:6px 10px",
    "border-radius:8px",
    "background:var(--bg-overlay)",
    "color:var(--text-primary)",
  ].join(";");
  element.append(document.createTextNode(preview.label));
  if (preview.additionalCount > 0) {
    const badge = document.createElement("span");
    badge.textContent = `+${preview.additionalCount}`;
    element.append(badge);
  }
  document.body.append(element);
  return { element, cleanup: () => element.remove() };
}

export function createFileDragSession(
  selection: FileSelectionState,
  path: string,
): FileDragSession | null {
  const started = beginFileDrag(selection, path);
  if (started.dragPaths.length === 0) return null;
  const focusedPath = started.state.focusedPath && started.dragPaths.includes(started.state.focusedPath)
    ? started.state.focusedPath
    : started.dragPaths[0]!;
  return {
    selection: started.state,
    paths: started.dragPaths,
    preview: {
      label: basename(focusedPath),
      additionalCount: started.dragPaths.length - 1,
    },
  };
}

export function writeFileDragData(
  transfer: DataTransfer,
  paths: readonly string[],
  scope: FileDragPayload["scope"],
): boolean {
  const parsed = FileDragPayloadSchema.safeParse({ version: 1, paths: [...paths], scope });
  if (!parsed.success) return false;
  const serialized = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(serialized).byteLength > MAX_FILE_DRAG_BYTES) return false;
  transfer.setData(FILE_MOVE_MIME, serialized);
  transfer.effectAllowed = "move";
  return true;
}

export function readFileDragData(
  transfer: DataTransfer,
  expectedScope: FileDragPayload["scope"],
): FileDragPayload | null {
  if (transfer.files.length > 0 || transfer.types.length !== 1 || transfer.types[0] !== FILE_MOVE_MIME) return null;
  const serialized = transfer.getData(FILE_MOVE_MIME);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_FILE_DRAG_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) return null;
    return null;
  }
  const parsed = FileDragPayloadSchema.safeParse(value);
  if (!parsed.success || !sameScope(parsed.data.scope, expectedScope)) return null;
  return parsed.data;
}

export function isValidFileDropTarget(payload: FileDragPayload, destination: string): boolean {
  return FileDragPayloadSchema.safeParse(payload).success
    && OwnerRelativePathSchema.safeParse(destination).success
    && destination !== payload.scope.directory
    && payload.paths.every((source) => destination !== source && !destination.startsWith(`${source}/`));
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function sameScope(left: FileDragPayload["scope"], right: FileDragPayload["scope"]): boolean {
  return left.directory === right.directory
    && left.runtimeSlot === right.runtimeSlot
    && left.authGeneration === right.authGeneration;
}
