import { create } from "zustand";

/**
 * Execution context supplied by whichever surface ran the command. The
 * command palette records the element focused before its search input stole
 * focus so focus can be returned there (e.g. Aoede dismiss restores it).
 */
export interface CommandExecutionContext {
  invoker?: HTMLElement;
}

export interface Command {
  id: string;
  label: string;
  group: "Apps" | "Actions" | "File" | "Edit" | "View";
  icon?: string;
  shortcut?: string;
  keywords?: string[];
  execute: (context?: CommandExecutionContext) => void;
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
