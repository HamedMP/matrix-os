import { create } from "zustand";

export interface Command {
  id: string;
  label: string;
  group: "Apps" | "Actions";
  icon?: string;
  shortcut?: string;
  keywords?: string[];
  execute: () => void;
}

interface CommandStore {
  commands: Map<string, Command>;
  register: (cmds: Command[]) => void;
  unregister: (ids: string[]) => void;
}

export const useCommandStore = create<CommandStore>()((set) => ({
  commands: new Map(),
  register: (cmds) =>
    set((state) => {
      const next = new Map(state.commands);
      for (const cmd of cmds) next.set(cmd.id, cmd);
      return { commands: next };
    }),
  unregister: (ids) =>
    set((state) => {
      const next = new Map(state.commands);
      for (const id of ids) next.delete(id);
      return { commands: next };
    }),
}));
