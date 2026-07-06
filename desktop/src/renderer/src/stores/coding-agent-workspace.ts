import type { RuntimeSummary } from "@matrix-os/contracts";
import { create } from "zustand";
import { invoke } from "../lib/operator";

type WorkspaceStatus = "idle" | "loading" | "ready" | "error";

interface CodingAgentWorkspaceState {
  status: WorkspaceStatus;
  summary: RuntimeSummary | null;
  error: string | null;
  refresh: () => Promise<void>;
}

let refreshSeq = 0;

export const useCodingAgentWorkspace = create<CodingAgentWorkspaceState>()((set) => ({
  status: "idle",
  summary: null,
  error: null,

  refresh: async () => {
    const seq = ++refreshSeq;
    set((state) => ({
      status: state.summary ? "ready" : "loading",
      error: null,
    }));
    try {
      const summary = await invoke("runtime:get-summary", {});
      if (seq !== refreshSeq) return;
      set({ status: "ready", summary, error: null });
    } catch {
      console.warn("[coding-agents] summary refresh failed");
      if (seq !== refreshSeq) return;
      set({ status: "error", error: "Runtime summary unavailable" });
    }
  },
}));
