import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Preferences {
  taskView: "grid" | "kanban";
  setTaskView: (view: "grid" | "kanban") => void;
}

export const usePreferences = create<Preferences>()(
  persist(
    (set) => ({
      taskView: "grid",
      setTaskView: (taskView) => set({ taskView }),
    }),
    { name: "matrix-os-preferences" },
  ),
);
