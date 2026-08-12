import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import type { BrowserEntry } from "./browser-entries";
import { createFileManagementApi } from "./file-management-api";
import { FileMutationNameSchema } from "./file-management-contracts";
import {
  createFileOperationController,
  type FileOperationSnapshot,
} from "./file-operation-controller";
import {
  createFileSelection,
  MAX_FILE_BATCH_SIZE,
  MAX_FILE_SELECTION,
  reconcileFileSelection,
  resetFileSelectionScope,
  updateFileSelection,
  type FileSelectionModifiers,
  type FileSelectionPlatform,
  type FileSelectionState,
} from "./file-selection";
import { useDirectorySync, type DirectorySyncSocket } from "./use-directory-sync";
import { useFileMove } from "./use-file-move";

export type FileNameDraft =
  | { mode: "create"; kind: "file" | "directory"; name: string }
  | { mode: "rename"; path: string; name: string };

const INVALID_NAME_NOTICE = "Choose a valid portable name.";
const BATCH_SELECTION_NOTICE = `Batch actions support up to ${MAX_FILE_BATCH_SIZE} selected items.`;
const NO_DIRECTORY_SOCKET: DirectorySyncSocket = {
  subscribeDirectory: () => () => {},
  touchDirectory: () => false,
};

export function useFileManagement(options: {
  api: ApiClient | null;
  directory: string;
  runtimeSlot: string;
  authGeneration: number;
  socket: DirectorySyncSocket | null;
  onFocusedPathChange?(path: string | null): void;
  loadAuthoritativeDirectory(
    directory: string,
    fetchEntries: () => Promise<BrowserEntry[]>,
  ): Promise<BrowserEntry[]>;
}) {
  const [draft, setDraft] = useState<FileNameDraft | null>(null);
  const [draftSubmitting, setDraftSubmitting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [trashPaths, setTrashPaths] = useState<string[]>([]);
  const syncBatchSelectionNotice = useCallback((selectedCount: number) => {
    setLocalNotice((notice) => selectedCount > MAX_FILE_BATCH_SIZE
      ? BATCH_SELECTION_NOTICE
      : notice === BATCH_SELECTION_NOTICE ? null : notice);
  }, []);
  const selectionScope = {
    directory: options.directory,
    runtimeSlot: options.runtimeSlot,
    authGeneration: options.authGeneration,
  };
  const [storedSelection, setStoredSelection] = useState<FileSelectionState>(
    () => createFileSelection(selectionScope),
  );
  const selection = resetFileSelectionScope(storedSelection, selectionScope);
  const scopeRef = useRef({
    directory: options.directory,
    runtimeSlot: options.runtimeSlot,
    authGeneration: options.authGeneration,
  });
  const onFocusRef = useRef(options.onFocusedPathChange);
  const selectionRef = useRef(storedSelection);
  const nextSubmissionRef = useRef(0);
  const activeSubmissionRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    scopeRef.current = {
      directory: options.directory,
      runtimeSlot: options.runtimeSlot,
      authGeneration: options.authGeneration,
    };
  }, [options.directory, options.runtimeSlot, options.authGeneration]);
  useLayoutEffect(() => {
    onFocusRef.current = options.onFocusedPathChange;
  }, [options.onFocusedPathChange]);

  const managementApi = useMemo(
    () => options.api ? createFileManagementApi(options.api) : null,
    [options.api],
  );
  const fetchEntries = useCallback(async (directory: string) => {
    if (!managementApi) return [];
    return (await managementApi.list(directory)).entries;
  }, [managementApi]);
  const controller = useMemo(() => createFileOperationController({
    getApi: () => managementApi,
    createRequestId: () => globalThis.crypto.randomUUID(),
    getScope: () => scopeRef.current,
    isScopeCurrent: (scope) => {
      const connection = useConnection.getState();
      const current = scopeRef.current;
      return connection.api === options.api
        && current.directory === scope.directory
        && connection.runtimeSlot === scope.runtimeSlot
        && connection.authGeneration === scope.authGeneration;
    },
    loadDirectory: async (directory, operationScope) => {
      const entries = await options.loadAuthoritativeDirectory(
        directory,
        () => fetchEntries(directory),
      );
      return entries.map((entry) => directory ? `${directory}/${entry.name}` : entry.name);
    },
  }), [managementApi, options.api, options.runtimeSlot, options.authGeneration, options.loadAuthoritativeDirectory, fetchEntries]);
  const [snapshot, setSnapshot] = useState<FileOperationSnapshot>(controller.snapshot);
  const settleMoveOutcome = useCallback((outcome: { retainedPaths: string[] }) => {
    const nextSelection: FileSelectionState = {
      scope: { ...scopeRef.current },
      selectedPaths: [...outcome.retainedPaths],
      anchorPath: outcome.retainedPaths[0] ?? null,
      focusedPath: outcome.retainedPaths[0] ?? null,
    };
    selectionRef.current = nextSelection;
    setStoredSelection(nextSelection);
    onFocusRef.current?.(nextSelection.focusedPath);
  }, []);
  const getMoveSelection = useCallback(() => selectionRef.current, []);
  const setMoveSelection = useCallback((nextSelection: FileSelectionState) => {
    selectionRef.current = nextSelection;
    setStoredSelection(nextSelection);
    onFocusRef.current?.(nextSelection.focusedPath);
  }, []);
  const move = useFileMove({
    api: options.api,
    controller,
    directory: options.directory,
    runtimeSlot: options.runtimeSlot,
    authGeneration: options.authGeneration,
    onOutcome: settleMoveOutcome,
    getSelection: getMoveSelection,
    onSelectionChange: setMoveSelection,
  });
  const requestMenuMove = useCallback((paths: readonly string[]) => {
    setLocalNotice(null);
    return move.requestMenuMove(paths);
  }, [move.requestMenuMove]);

  useEffect(() => {
    setSnapshot(controller.snapshot);
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      controller.close();
    };
  }, [controller]);

  useEffect(() => {
    controller.syncScope();
    setSnapshot(controller.snapshot);
    setDraft(null);
    activeSubmissionRef.current = null;
    setDraftSubmitting(false);
    setDraftError(null);
    setLocalNotice(null);
    setTrashPaths([]);
    const nextSelection = resetFileSelectionScope(selectionRef.current, scopeRef.current);
    selectionRef.current = nextSelection;
    setStoredSelection(nextSelection);
    onFocusRef.current?.(null);
  }, [controller, options.directory, options.runtimeSlot, options.authGeneration]);

  const loadSyncEntries = useCallback((directory: string) =>
    options.loadAuthoritativeDirectory(directory, () => fetchEntries(directory)),
  [fetchEntries, options.loadAuthoritativeDirectory]);
  const applySyncEntries = useCallback(() => {}, []);
  useDirectorySync({
    socket: options.socket ?? NO_DIRECTORY_SOCKET,
    directory: options.directory,
    runtimeSlot: options.runtimeSlot,
    authGeneration: options.authGeneration,
    loadDirectory: loadSyncEntries,
    onReconciled: applySyncEntries,
  });

  const startCreate = useCallback((kind: "file" | "directory") => {
    setDraft({ mode: "create", kind, name: "" });
    setDraftError(null);
  }, []);

  const updateDraftName = useCallback((name: string) => {
    setDraft((current) => current ? { ...current, name } : null);
  }, []);

  const startRename = useCallback((path: string, name: string) => {
    setDraft({ mode: "rename", path, name });
    setDraftError(null);
  }, []);

  const cancelDraft = useCallback(() => {
    setDraft(null);
    setDraftError(null);
  }, []);

  const submitDraft = useCallback(async () => {
    if (!draft || activeSubmissionRef.current !== null) return;
    if (!FileMutationNameSchema.safeParse(draft.name).success) {
      setDraftError(INVALID_NAME_NOTICE);
      return;
    }
    const submission = ++nextSubmissionRef.current;
    activeSubmissionRef.current = submission;
    setDraftSubmitting(true);
    const expectedPath = draft.mode === "create"
      ? joinPath(options.directory, draft.name)
      : joinPath(parentDirectory(draft.path), draft.name);
    try {
      const outcome = draft.mode === "create"
        ? await controller.create({ parentDirectory: options.directory, name: draft.name, kind: draft.kind })
        : await controller.rename({ path: draft.path, name: draft.name });
      const reconciledIdentity = draft.mode === "rename" ? draft.path : expectedPath;
      if (outcome.status === "completed" || outcome.succeededPaths.includes(reconciledIdentity)) {
        setDraft(null);
        setDraftError(null);
        return;
      }
      if (outcome.failures.some((failure) => failure.code === "destination_conflict")) {
        setDraftError("An item with that name already exists.");
      }
    } finally {
      if (activeSubmissionRef.current === submission) {
        activeSubmissionRef.current = null;
        setDraftSubmitting(false);
      }
    }
  }, [controller, draft, options.directory]);

  const selectPath = useCallback((
    renderedPaths: readonly string[],
    path: string,
    modifiers: FileSelectionModifiers,
    platform: FileSelectionPlatform,
  ) => {
    const current = resetFileSelectionScope(selectionRef.current, scopeRef.current);
    const anchorIndex = current.anchorPath ? renderedPaths.indexOf(current.anchorPath) : -1;
    const clickedIndex = renderedPaths.indexOf(path);
    const additive = platform === "mac" ? modifiers.metaKey : modifiers.ctrlKey;
    const overLimit = (modifiers.shiftKey && anchorIndex >= 0 && clickedIndex >= 0
      && Math.abs(anchorIndex - clickedIndex) + 1 > MAX_FILE_SELECTION)
      || (additive && !current.selectedPaths.includes(path) && current.selectedPaths.length >= MAX_FILE_SELECTION);
    if (overLimit) setLocalNotice(`Select up to ${MAX_FILE_SELECTION} items at a time.`);
    const next = updateFileSelection(
      current,
      renderedPaths,
      path,
      modifiers,
      platform,
    );
    syncBatchSelectionNotice(next.selectedPaths.length);
    selectionRef.current = next;
    setStoredSelection(next);
  }, [syncBatchSelectionNotice]);

  const reconcilePaths = useCallback((renderedPaths: readonly string[]) => {
    const current = resetFileSelectionScope(selectionRef.current, scopeRef.current);
    const next = reconcileFileSelection(current, scopeRef.current, renderedPaths);
    selectionRef.current = next;
    syncBatchSelectionNotice(next.selectedPaths.length);
    if (current.focusedPath && !renderedPaths.includes(current.focusedPath)) onFocusRef.current?.(null);
    if (!sameSelection(current, next)) setStoredSelection(next);
  }, [syncBatchSelectionNotice]);

  const requestTrash = useCallback((paths: readonly string[]) => {
    if (paths.length < 1 || paths.length > MAX_FILE_BATCH_SIZE) {
      setLocalNotice(`Select between 1 and ${MAX_FILE_BATCH_SIZE} items to move to Trash.`);
      return;
    }
    setLocalNotice(null);
    setTrashPaths([...paths]);
  }, []);

  const cancelTrash = useCallback(() => setTrashPaths([]), []);

  const confirmTrash = useCallback(async () => {
    const paths = [...trashPaths];
    if (paths.length < 1) return;
    setTrashPaths([]);
    const outcome = await controller.trash({ sources: paths });
    if (outcome.status === "stale") return;
    const nextSelection: FileSelectionState = {
      scope: { ...scopeRef.current },
      selectedPaths: [...outcome.retainedPaths],
      anchorPath: outcome.retainedPaths[0] ?? null,
      focusedPath: outcome.retainedPaths[0] ?? null,
    };
    selectionRef.current = nextSelection;
    syncBatchSelectionNotice(nextSelection.selectedPaths.length);
    setStoredSelection(nextSelection);
    onFocusRef.current?.(nextSelection.focusedPath);
  }, [controller, syncBatchSelectionNotice, trashPaths]);

  return {
    draft, draftError, draftSubmitting, localNotice, snapshot, selection, trashPaths,
    startCreate, startRename, updateDraftName, cancelDraft, submitDraft, selectPath,
    reconcilePaths, requestTrash, cancelTrash, confirmTrash,
    move: { ...move, requestMenuMove },
  };
}

function sameSelection(left: FileSelectionState, right: FileSelectionState): boolean {
  return left.anchorPath === right.anchorPath
    && left.focusedPath === right.focusedPath
    && left.selectedPaths.length === right.selectedPaths.length
    && left.selectedPaths.every((path, index) => path === right.selectedPaths[index]);
}

function sameScope(left: FileSelectionState["scope"], right: FileSelectionState["scope"]): boolean {
  return left.directory === right.directory
    && left.runtimeSlot === right.runtimeSlot
    && left.authGeneration === right.authGeneration;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
