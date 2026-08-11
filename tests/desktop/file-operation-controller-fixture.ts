import { vi } from "vitest";
import {
  createFileOperationController,
  type FileOperationScope,
} from "@desktop/renderer/src/features/files/file-operation-controller";
import type { FileManagementApi } from "@desktop/renderer/src/features/files/file-management-api";

export const CAPS = { canRename: true, canMove: true, canTrash: true };
export const IDS = Array.from(
  { length: 20 },
  (_, index) => `123e4567-e89b-42d3-a456-${(426614174000 + index).toString()}`,
);

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function makeApi(overrides: Partial<FileManagementApi> = {}): FileManagementApi {
  return {
    list: vi.fn(), create: vi.fn(), rename: vi.fn(), preflightMove: vi.fn(),
    executeMove: vi.fn(), trash: vi.fn(), ...overrides,
  } as FileManagementApi;
}

export function makeHarness(overrides: {
  api?: FileManagementApi;
  loadDirectory?: (directory: string, scope: FileOperationScope) => Promise<readonly string[]>;
  isScopeCurrent?: (scope: FileOperationScope) => boolean;
  createRequestId?: () => string;
} = {}) {
  let scope: FileOperationScope = { directory: "projects", runtimeSlot: "primary", authGeneration: 1 };
  let idIndex = 0;
  const api = overrides.api ?? makeApi();
  const loadDirectory = vi.fn(overrides.loadDirectory ?? (async () => []));
  const controller = createFileOperationController({
    getApi: () => api,
    createRequestId: overrides.createRequestId ?? (() => IDS[idIndex++]!),
    getScope: () => scope,
    loadDirectory,
    ...(overrides.isScopeCurrent ? { isScopeCurrent: overrides.isScopeCurrent } : {}),
  });
  return {
    api, controller, loadDirectory,
    get scope() { return scope; },
    setScope(next: FileOperationScope) { scope = next; controller.syncScope(); },
  };
}
