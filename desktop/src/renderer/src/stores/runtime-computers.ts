import {
  MatrixComputerListSchema,
  type MatrixComputer,
} from "@matrix-os/contracts";
import { create } from "zustand";
import { invoke } from "../lib/operator";
import { useConnection } from "./connection";

type RuntimeComputerLoadStatus = "idle" | "loading" | "ready" | "error";

interface RuntimeComputerState {
  status: RuntimeComputerLoadStatus;
  scope: string | null;
  runtimeSlot: string | null;
  computers: MatrixComputer[];
  switchingSlot: string | null;
  switchError: boolean;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  select: (slot: string) => Promise<boolean>;
}

let refreshGeneration = 0;

function currentScope(): { scope: string; runtimeSlot: string } | null {
  const connection = useConnection.getState();
  if (connection.status !== "signed-in" || !connection.platformHost) return null;
  return {
    scope: `${connection.platformHost}|${connection.handle ?? "signed-in"}`,
    runtimeSlot: connection.runtimeSlot,
  };
}

export const useRuntimeComputers = create<RuntimeComputerState>()((set, get) => ({
  status: "idle",
  scope: null,
  runtimeSlot: null,
  computers: [],
  switchingSlot: null,
  switchError: false,

  refresh: async (options = {}) => {
    const target = currentScope();
    if (!target) {
      refreshGeneration += 1;
      set({
        status: "idle",
        scope: null,
        runtimeSlot: null,
        computers: [],
        switchingSlot: null,
        switchError: false,
      });
      return;
    }
    const state = get();
    const sameTarget = state.scope === target.scope && state.runtimeSlot === target.runtimeSlot;
    if (!options.force && sameTarget && (state.status === "loading" || state.status === "ready")) return;
    const generation = ++refreshGeneration;
    set({
      status: "loading",
      scope: target.scope,
      runtimeSlot: target.runtimeSlot,
      ...(sameTarget ? {} : { computers: [] }),
      switchError: false,
    });
    try {
      const response = await invoke("runtime:list-computers", {});
      const parsed = MatrixComputerListSchema.safeParse(response);
      if (!parsed.success) throw new Error("invalid computer list");
      if (generation !== refreshGeneration) return;
      set({
        status: "ready",
        computers: parsed.data.items,
        runtimeSlot: parsed.data.selectedSlot ?? target.runtimeSlot,
      });
    } catch {
      if (generation !== refreshGeneration) return;
      set({ status: "error", computers: [] });
    }
  },

  select: async (slot) => {
    const state = get();
    const computer = state.computers.find((candidate) => candidate.runtimeSlot === slot);
    const connection = useConnection.getState();
    if (
      !computer
      || computer.availability !== "available"
      || state.runtimeSlot === slot
      || connection.runtimeSlot === slot
      || state.switchingSlot
    ) {
      return false;
    }
    set({ switchingSlot: slot, switchError: false });
    try {
      await connection.selectRuntime(slot);
      set({ switchingSlot: null });
      await get().refresh({ force: true });
      return true;
    } catch {
      set({ switchingSlot: null, switchError: true });
      return false;
    }
  },
}));

useConnection.subscribe((connection, previous) => {
  const signedOut = previous.status === "signed-in" && connection.status !== "signed-in";
  const signedInSessionReplaced = previous.status === "signed-in"
    && connection.status === "signed-in"
    && previous.api !== connection.api;
  if (!signedOut && !signedInSessionReplaced) return;
  refreshGeneration += 1;
  useRuntimeComputers.setState({
    status: "idle",
    scope: null,
    runtimeSlot: null,
    computers: [],
    switchingSlot: null,
    switchError: false,
  });
});
