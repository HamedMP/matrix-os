import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import type { ApiClient } from "../../lib/api";
import type { FileConflictChoice } from "./file-management-api";
import {
  createFileDragSession,
  hasOnlyInternalFileMoveType,
  isValidFileDropTarget,
  mountFileDragPreview,
  readFileDragData,
  writeFileDragData,
  type FileDragPayload,
} from "./file-drag";
import type { FileSelectionState } from "./file-selection";
import type {
  ControllerMovePreflight,
  FileOperationController,
  FileOperationOutcome,
} from "./file-operation-controller";
import { parentDirectory, validBatchSources } from "./file-operation-reconciliation";

export type FileMoveOrigin = "menu" | "drag";
export type FileMoveStage = "picking" | "preflighting" | "resolving" | "executing";

export interface FileMoveSession {
  origin: FileMoveOrigin;
  stage: FileMoveStage;
  sources: string[];
  destination: string | null;
  preflight: ControllerMovePreflight | null;
  choices: Array<{ source: string; resolution: "keep-both" | "skip" | null }>;
  applyToRemaining: boolean;
}

interface MoveOwner {
  api: ApiClient | null;
  directory: string;
  runtimeSlot: string;
  authGeneration: number;
}

export function useFileMove(options: MoveOwner & {
  controller: FileOperationController;
  onOutcome(outcome: FileOperationOutcome): void;
  getSelection(): FileSelectionState;
  onSelectionChange(selection: FileSelectionState): void;
}) {
  const [storedSession, setStoredSession] = useState<FileMoveSession | null>(null);
  const [storedDropTarget, setStoredDropTarget] = useState<string | null>(null);
  const ownerRef = useRef<MoveOwner | null>(null);
  const dragOwnerRef = useRef<MoveOwner | null>(null);
  const dragPayloadRef = useRef<FileDragPayload | null>(null);
  const previewCleanupRef = useRef<(() => void) | null>(null);
  const currentRef = useRef<MoveOwner>(options);
  const epochRef = useRef(0);
  useLayoutEffect(() => { currentRef.current = options; }, [options.api, options.directory, options.runtimeSlot, options.authGeneration]);

  const session = storedSession && sameOwner(ownerRef.current, options) ? storedSession : null;
  const dropTarget = sameOwner(dragOwnerRef.current, options) ? storedDropTarget : null;

  const cleanupDrag = useCallback((clearTarget = true) => {
    previewCleanupRef.current?.();
    previewCleanupRef.current = null;
    dragPayloadRef.current = null;
    dragOwnerRef.current = null;
    if (clearTarget) setStoredDropTarget(null);
  }, []);

  useEffect(() => {
    epochRef.current += 1;
    setStoredSession(null);
    ownerRef.current = null;
    cleanupDrag();
    return () => cleanupDrag(false);
  }, [cleanupDrag, options.api, options.controller, options.directory, options.runtimeSlot, options.authGeneration]);

  const stillCurrent = useCallback((owner: MoveOwner, epoch: number) =>
    epoch === epochRef.current && sameOwner(owner, currentRef.current), []);

  const finishExecute = useCallback(async (
    base: FileMoveSession,
    preflight: ControllerMovePreflight,
    conflictChoices: FileConflictChoice[],
    owner: MoveOwner,
    epoch: number,
  ) => {
    if (!stillCurrent(owner, epoch)) return;
    setStoredSession({ ...base, stage: "executing", preflight });
    const outcome = await options.controller.executeMove({ preflight, conflictChoices });
    if (!stillCurrent(owner, epoch) || outcome.status === "stale") return;
    setStoredSession(null);
    ownerRef.current = null;
    options.onOutcome(outcome);
  }, [options.controller, options.onOutcome, stillCurrent]);

  const beginPreflight = useCallback(async (
    base: FileMoveSession,
    destination: string,
  ) => {
    const owner = ownerRef.current;
    if (!owner || !sameOwner(owner, currentRef.current)) return;
    const payload = {
      version: 1 as const,
      paths: base.sources,
      scope: {
        directory: owner.directory,
        runtimeSlot: owner.runtimeSlot,
        authGeneration: owner.authGeneration,
      },
    };
    if (!isValidFileDropTarget(payload, destination)) return;
    const epoch = epochRef.current;
    setStoredSession({ ...base, stage: "preflighting", destination });
    const outcome = await options.controller.preflightMove({ sources: base.sources, destinationDirectory: destination });
    if (!stillCurrent(owner, epoch)) {
      if (outcome.preflight) options.controller.cancelMove(outcome.preflight);
      return;
    }
    const preflight = outcome.preflight;
    if (!preflight || outcome.status === "stale" || outcome.status === "failed") {
      setStoredSession(null);
      ownerRef.current = null;
      return;
    }
    const prepared = { ...base, destination, preflight };
    if (preflight.conflicts.length === 0 && preflight.invalid.length === 0) {
      await finishExecute(prepared, preflight, [], owner, epoch);
      return;
    }
    setStoredSession({
      ...prepared,
      stage: "resolving",
      choices: preflight.conflicts.map((conflict) => ({ source: conflict.source, resolution: null })),
    });
  }, [finishExecute, options.controller, stillCurrent]);

  const requestMenuMove = useCallback((sources: readonly string[]) => {
    if (!validBatchSources(sources) || sources.some((source) => parentDirectory(source) !== options.directory)) return false;
    const owner = captureOwner(options);
    ownerRef.current = owner;
    epochRef.current += 1;
    setStoredSession({
      origin: "menu", stage: "picking", sources: [...sources], destination: null,
      preflight: null, choices: [], applyToRemaining: false,
    });
    return true;
  }, [options.api, options.directory, options.runtimeSlot, options.authGeneration]);

  const beginDrag = useCallback((path: string, transfer: DataTransfer, allowedPaths: readonly string[]) => {
    const started = createFileDragSession(options.getSelection(), path);
    if (!started || started.paths.some((source) => !allowedPaths.includes(source))) return false;
    const owner = captureOwner(options);
    const scope = {
      directory: owner.directory,
      runtimeSlot: owner.runtimeSlot,
      authGeneration: owner.authGeneration,
    };
    if (!writeFileDragData(transfer, started.paths, scope)) return false;
    cleanupDrag();
    const preview = mountFileDragPreview(document, started.preview);
    transfer.setDragImage(preview.element, 12, 12);
    previewCleanupRef.current = preview.cleanup;
    dragOwnerRef.current = owner;
    dragPayloadRef.current = { version: 1, paths: started.paths, scope };
    options.onSelectionChange(started.selection);
    return true;
  }, [cleanupDrag, options]);

  const dragOverTarget = useCallback((destination: string, transfer: DataTransfer) => {
    const owner = dragOwnerRef.current;
    const expected = owner && sameOwner(owner, currentRef.current) ? owner : null;
    if (!expected) {
      setStoredDropTarget(null);
      return false;
    }
    const payload = dragPayloadRef.current;
    if (!payload || !hasOnlyInternalFileMoveType(transfer) || !isValidFileDropTarget(payload, destination)) {
      setStoredDropTarget(null);
      return false;
    }
    transfer.dropEffect = "move";
    setStoredDropTarget(destination);
    return true;
  }, []);

  const leaveDropTarget = useCallback((destination: string) => {
    setStoredDropTarget((current) => current === destination ? null : current);
  }, []);

  const dropOnTarget = useCallback((destination: string, transfer: DataTransfer) => {
    const owner = dragOwnerRef.current;
    if (!owner || !sameOwner(owner, currentRef.current)) {
      cleanupDrag();
      return false;
    }
    const scope = { directory: owner.directory, runtimeSlot: owner.runtimeSlot, authGeneration: owner.authGeneration };
    const payload = readFileDragData(transfer, scope);
    if (!payload || !samePayload(payload, dragPayloadRef.current) || !isValidFileDropTarget(payload, destination)) {
      cleanupDrag();
      return false;
    }
    cleanupDrag();
    ownerRef.current = owner;
    epochRef.current += 1;
    const base: FileMoveSession = {
      origin: "drag", stage: "preflighting", sources: [...payload.paths], destination,
      preflight: null, choices: [], applyToRemaining: false,
    };
    setStoredSession(base);
    void beginPreflight(base, destination);
    return true;
  }, [beginPreflight, cleanupDrag]);

  const entryDragProps = useCallback((path: string, directory: boolean, allowedPaths: readonly string[]) => {
    const candidate = createFileDragSession(options.getSelection(), path);
    const draggable = candidate !== null && candidate.paths.every((source) => allowedPaths.includes(source));
    return {
      draggable,
      dropTarget: directory && dropTarget === path,
      onDragStart: (event: DragEvent<HTMLButtonElement>) => {
        if (!beginDrag(path, event.dataTransfer, allowedPaths)) event.preventDefault();
      },
      onDragEnd: () => cleanupDrag(),
      ...(directory ? {
        onDragOver: (event: DragEvent<HTMLButtonElement>) => {
          if (dragOverTarget(path, event.dataTransfer)) event.preventDefault();
        },
        onDragLeave: () => leaveDropTarget(path),
        onDrop: (event: DragEvent<HTMLButtonElement>) => {
          if (dropOnTarget(path, event.dataTransfer)) event.preventDefault();
        },
      } : {}),
    };
  }, [beginDrag, cleanupDrag, dragOverTarget, dropOnTarget, dropTarget, leaveDropTarget, options]);

  const chooseDestination = useCallback((destination: string) => {
    if (session?.stage !== "picking") return;
    void beginPreflight(session, destination);
  }, [beginPreflight, session]);

  const chooseCandidate = useCallback((destination: string) => {
    setStoredSession((current) => current?.stage === "picking"
      ? { ...current, destination }
      : current);
  }, []);

  const setApplyToRemaining = useCallback((apply: boolean) => {
    setStoredSession((current) => current?.stage === "resolving"
      ? { ...current, applyToRemaining: apply }
      : current);
  }, []);

  const chooseConflict = useCallback((source: string, resolution: "keep-both" | "skip") => {
    setStoredSession((current) => {
      if (current?.stage !== "resolving") return current;
      const at = current.choices.findIndex((choice) => choice.source === source);
      if (at < 0) return current;
      return {
        ...current,
        choices: current.choices.map((choice, index) => ({
          ...choice,
          resolution: index === at || (current.applyToRemaining && index > at)
            ? resolution
            : choice.resolution,
        })),
      };
    });
  }, []);

  const confirmMove = useCallback(() => {
    if (session?.stage !== "resolving" || !session.preflight || session.choices.some((choice) => choice.resolution === null)) return;
    const owner = ownerRef.current;
    if (!owner || !sameOwner(owner, currentRef.current)) return;
    const choices = session.choices.map((choice) => ({
      source: choice.source,
      resolution: choice.resolution!,
    }));
    void finishExecute(session, session.preflight, choices, owner, epochRef.current);
  }, [finishExecute, session]);

  const cancelMove = useCallback(() => {
    if (session?.stage === "executing") return;
    epochRef.current += 1;
    if (session?.preflight) options.controller.cancelMove(session.preflight);
    setStoredSession(null);
    ownerRef.current = null;
  }, [options.controller, session]);

  return {
    session, requestMenuMove, chooseCandidate, chooseDestination, setApplyToRemaining,
    chooseConflict, confirmMove, cancelMove, dropTarget,
    beginDrag, dragOverTarget, leaveDropTarget, dropOnTarget,
    endDrag: cleanupDrag, entryDragProps,
    dropHandlers: {
      activePath: dropTarget,
      onDragOver: dragOverTarget,
      onDragLeave: leaveDropTarget,
      onDrop: dropOnTarget,
    },
  };
}

function captureOwner(owner: MoveOwner): MoveOwner {
  return {
    api: owner.api,
    directory: owner.directory,
    runtimeSlot: owner.runtimeSlot,
    authGeneration: owner.authGeneration,
  };
}

function sameOwner(left: MoveOwner | null, right: MoveOwner): boolean {
  return left !== null && left.api === right.api && left.directory === right.directory
    && left.runtimeSlot === right.runtimeSlot && left.authGeneration === right.authGeneration;
}

function samePayload(left: FileDragPayload, right: FileDragPayload | null): boolean {
  return right !== null && left.version === right.version
    && left.scope.directory === right.scope.directory
    && left.scope.runtimeSlot === right.scope.runtimeSlot
    && left.scope.authGeneration === right.scope.authGeneration
    && left.paths.length === right.paths.length
    && left.paths.every((path, index) => path === right.paths[index]);
}
