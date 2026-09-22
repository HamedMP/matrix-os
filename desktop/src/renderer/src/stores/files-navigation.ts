import { create } from "zustand";
import { useConnection } from "./connection";
import { captureRuntimeGeneration } from "./runtime-generation";

interface FilesRequest {
  path: string;
  runtimeSlot: string;
  authGeneration: number;
  generation: number;
}

// One pending intent; new navigation replaces old intent and consumption clears it.
export const useFilesNavigation = create<{
  request: FilesRequest | null;
  navigate(path: string): void;
  consume(request: FilesRequest): void;
}>((set) => ({
  request: null,
  navigate: (path) => {
    const { runtimeSlot, authGeneration } = useConnection.getState();
    set({ request: { path, runtimeSlot, authGeneration, generation: captureRuntimeGeneration() } });
  },
  consume: (request) => set(state => state.request === request ? { request: null } : {}),
}));
