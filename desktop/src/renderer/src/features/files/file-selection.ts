import { MAX_BROWSER_ENTRIES } from "./browser-entries";

export const MAX_FILE_BATCH_SIZE = 100;
export const MAX_FILE_SELECTION = MAX_BROWSER_ENTRIES;

export interface FileSelectionScope {
  directory: string;
  runtimeSlot: string;
  authGeneration: number;
}

export interface FileSelectionState {
  scope: FileSelectionScope;
  selectedPaths: string[];
  anchorPath: string | null;
  focusedPath: string | null;
}

export type FileSelectionPlatform = "mac" | "windows" | "linux";

export interface FileSelectionModifiers {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export function createFileSelection(scope: FileSelectionScope): FileSelectionState {
  return {
    scope: { ...scope },
    selectedPaths: [],
    anchorPath: null,
    focusedPath: null,
  };
}

export function resetFileSelectionScope(
  state: FileSelectionState,
  scope: FileSelectionScope,
): FileSelectionState {
  return sameScope(state.scope, scope) ? state : createFileSelection(scope);
}

export function updateFileSelection(
  state: FileSelectionState,
  renderedPaths: readonly string[],
  clickedPath: string,
  modifiers: FileSelectionModifiers,
  platform: FileSelectionPlatform,
): FileSelectionState {
  const visible = renderedPaths.filter((path) => parentDirectory(path) === state.scope.directory);
  const clickedIndex = visible.indexOf(clickedPath);
  if (clickedIndex < 0 || parentDirectory(clickedPath) !== state.scope.directory) return state;

  const additive = platform === "mac" ? modifiers.metaKey === true : modifiers.ctrlKey === true;
  if (modifiers.shiftKey) {
    const anchorIndex = state.anchorPath ? visible.indexOf(state.anchorPath) : -1;
    if (anchorIndex < 0) return singleSelection(state.scope, clickedPath);
    const start = Math.min(anchorIndex, clickedIndex);
    const end = Math.max(anchorIndex, clickedIndex);
    const range = visible.slice(start, end + 1);
    const selected = additive
      ? orderSelected(visible, [...state.selectedPaths, ...range])
      : range.slice(0, MAX_FILE_SELECTION);
    return {
      scope: state.scope,
      selectedPaths: selected,
      anchorPath: state.anchorPath,
      focusedPath: clickedPath,
    };
  }

  if (!additive) return singleSelection(state.scope, clickedPath);
  const next = state.selectedPaths.includes(clickedPath)
    ? state.selectedPaths.filter((path) => path !== clickedPath)
    : [...state.selectedPaths, clickedPath];
  return {
    scope: state.scope,
    selectedPaths: orderSelected(visible, next),
    anchorPath: clickedPath,
    focusedPath: clickedPath,
  };
}

export function reconcileFileSelection(
  state: FileSelectionState,
  scope: FileSelectionScope,
  renderedPaths: readonly string[],
): FileSelectionState {
  if (!sameScope(state.scope, scope)) return createFileSelection(scope);
  const visibleSiblings = renderedPaths.filter((path) => parentDirectory(path) === scope.directory);
  const selectedPaths = orderSelected(visibleSiblings, state.selectedPaths);
  const anchorPath = state.anchorPath && selectedPaths.includes(state.anchorPath)
    ? state.anchorPath
    : selectedPaths[0] ?? null;
  const focusedPath = state.focusedPath && visibleSiblings.includes(state.focusedPath)
    ? state.focusedPath
    : selectedPaths[0] ?? null;
  return { scope: state.scope, selectedPaths, anchorPath, focusedPath };
}

export function beginFileDrag(
  state: FileSelectionState,
  path: string,
): { state: FileSelectionState; dragPaths: string[] } {
  if (parentDirectory(path) !== state.scope.directory) return { state, dragPaths: [] };
  const siblingSelection = state.selectedPaths
    .filter((selectedPath) => parentDirectory(selectedPath) === state.scope.directory)
    .slice(0, MAX_FILE_SELECTION);
  if (siblingSelection.includes(path)) {
    if (siblingSelection.length > MAX_FILE_BATCH_SIZE) return { state, dragPaths: [] };
    return { state: { ...state, selectedPaths: siblingSelection }, dragPaths: [...siblingSelection] };
  }
  const nextState = singleSelection(state.scope, path);
  return { state: nextState, dragPaths: [path] };
}

function singleSelection(scope: FileSelectionScope, path: string): FileSelectionState {
  return { scope, selectedPaths: [path], anchorPath: path, focusedPath: path };
}

function orderSelected(renderedPaths: readonly string[], selectedPaths: readonly string[]): string[] {
  const selected = new Set(selectedPaths.slice(0, MAX_FILE_SELECTION));
  return renderedPaths.filter((path) => selected.has(path)).slice(0, MAX_FILE_SELECTION);
}

function sameScope(left: FileSelectionScope, right: FileSelectionScope): boolean {
  return left.directory === right.directory
    && left.runtimeSlot === right.runtimeSlot
    && left.authGeneration === right.authGeneration;
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
