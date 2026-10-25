import { z } from "zod/v4";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { FilePathSchema, FileResourceRefSchema } from "@matrix-os/contracts";
import { useConnection } from "./connection";
import { captureRuntimeGeneration } from "./runtime-generation";
import type { FileResourceRef } from "@matrix-os/contracts";

interface FilesRequest {
  project?: Extract<FileResourceRef, { kind: "project" }>;
  directory?: boolean;
  path: string;
  driveScopeId?: string;
  driveIntentId?: string;
  runtimeSlot: string;
  authGeneration: number;
  generation: number;
}

// One pending intent; new navigation replaces old intent and consumption clears it.
export const useFilesNavigation = create<{
  request: FilesRequest | null;
  navigate(path: string): void;
  navigateProject(resource: Extract<FileResourceRef, { kind: "project" }>, directory: boolean): void;
  navigateDrive(scopeId: string): void;
  consume(request: FilesRequest): void;
}>((set) => ({
  request: null,
  navigateProject: (project, directory) => {
    const { runtimeSlot, authGeneration } = useConnection.getState();
    set({ request: { path: project.path, project, directory, runtimeSlot, authGeneration, generation: captureRuntimeGeneration() } });
  },
  navigate: (path) => {
    const { runtimeSlot, authGeneration } = useConnection.getState();
    set({ request: { path, runtimeSlot, authGeneration, generation: captureRuntimeGeneration() } });
  },
  navigateDrive: (scopeId) => {
    const { runtimeSlot, authGeneration } = useConnection.getState();
    set({ request: { path: "", driveScopeId: z.uuid().parse(scopeId), driveIntentId: crypto.randomUUID(), runtimeSlot, authGeneration, generation: captureRuntimeGeneration() } });
  },
  consume: (request) => set(state => state.request === request ? { request: null } : {}),
}));

// Only navigation preferences are retained: never listings, file contents or credentials.
const FileViewSchema = z.object({
  treeInitialized: z.boolean().default(false),
  expandedPaths: z.array(FilePathSchema).max(199).default([]),
  query: z.string().max(80).default(""),
  scrollTop: z.number().min(0).max(100_000_000).default(0),
  treeVisible: z.boolean().default(true),
  treeWidth: z.number().min(220).max(2000).default(300),
  selectedFile: FileResourceRefSchema.nullable().default(null),
});
export type InspectorFileView = z.infer<typeof FileViewSchema>;
export const EMPTY_INSPECTOR_FILE_VIEW: InspectorFileView = FileViewSchema.parse({});
const FileViewsSchema = z.object({ views: z.array(z.object({ key: z.string().max(2048), view: FileViewSchema })).max(32) });

export function inspectorFileViewKey(scope: { kind: string; chatId: string; projectId?: string; worktreeId?: string }): string {
  const connection = useConnection.getState();
  return JSON.stringify([connection.platformHost, connection.userId ?? `session:${connection.authGeneration}`, connection.runtimeSlot,
    scope.chatId, scope.kind, scope.projectId ?? "", scope.worktreeId ?? ""]);
}

export const useInspectorFileViews = create<{
  views: Array<{ key: string; view: InspectorFileView }>;
  update(key: string, patch: Partial<InspectorFileView>): void;
}>()(persist((set) => ({
  views: [],
  update: (key, patch) => set((state) => {
    const existing = state.views.find((entry) => entry.key === key)?.view ?? EMPTY_INSPECTOR_FILE_VIEW;
    const view = FileViewSchema.parse({ ...existing, ...patch });
    if (patch.selectedFile === undefined) view.selectedFile = existing.selectedFile;
    // Most recently used 32 views; the serialized preference budget is also bounded.
    const views = [...state.views.filter((entry) => entry.key !== key), { key, view }].slice(-32);
    while (views.length > 1 && JSON.stringify(views).length > 1_000_000) views.shift();
    return { views };
  }),
}), {
  name: "matrix-inspector-file-views-v1",
  storage: createJSONStorage(() => ({
    getItem: (name) => { try { const value = localStorage.getItem(name); return value && value.length <= 1_100_000 ? value : null; } catch (error: unknown) { console.warn("[files] preferences unavailable", error instanceof Error ? error.name : "UnknownError"); return null; } },
    setItem: (name, value) => { try { localStorage.setItem(name, value); } catch (error: unknown) { console.warn("[files] preferences unavailable", error instanceof Error ? error.name : "UnknownError"); } },
    removeItem: (name) => { try { localStorage.removeItem(name); } catch (error: unknown) { console.warn("[files] preferences unavailable", error instanceof Error ? error.name : "UnknownError"); } },
  })),
  partialize: (state) => ({ views: state.views }),
  merge: (saved, current) => {
    const parsed = FileViewsSchema.safeParse(saved);
    return parsed.success ? { ...current, views: parsed.data.views } : current;
  },
}));
