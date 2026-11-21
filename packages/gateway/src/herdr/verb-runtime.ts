// Herdr terminals in 2692's terminal verbs, waits, events and attention: the
// Matrix terminal runtime, with the owner's Herdr terminals added as one more
// canonical workspace. Reads and writes for a Herdr ref go to herdr-core;
// everything else goes to the Matrix runtime unchanged.
import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import { isHerdrTerminalRef } from "@matrix-os/contracts/herdr-terminals";
import type { TerminalAgentStatusEntry } from "@matrix-os/terminal-runtime";
import { TerminalAgentVerbError, type TerminalAgentVerbRuntime } from "../terminal-agent/verbs.js";
import type { HerdrScreen } from "./adapter.js";

/** What the terminal-agent pipeline needs from the Herdr adapter. */
export interface HerdrTerminalSource {
  workspace(): Promise<TerminalWorkspace | null>;
  statuses(): Promise<TerminalAgentStatusEntry[]>;
  resolve(ref: TerminalRef): string | undefined;
  captureScreen(id: string, lines: number): Promise<HerdrScreen>;
  writeInput(id: string, data: string): Promise<void>;
}

export type TerminalAgentPipelineRuntime = TerminalAgentVerbRuntime & {
  listAgentStatuses?(): Promise<TerminalAgentStatusEntry[]>;
};

function warn(message: string, error: unknown): void {
  console.warn(`[herdr] ${message}`, error instanceof Error ? error.name : "unknown_error");
}

export function withHerdrTerminals(
  runtime: TerminalAgentPipelineRuntime,
  herdr: HerdrTerminalSource,
): Required<Pick<TerminalAgentPipelineRuntime, "listAgentStatuses" | "captureScreen">> & TerminalAgentPipelineRuntime {
  async function herdrWorkspace(): Promise<TerminalWorkspace | null> {
    try { return await herdr.workspace(); }
    catch (error: unknown) {
      // Herdr is optional: a core that cannot be read hides its terminals, never Matrix's.
      warn("terminal listing unavailable", error);
      return null;
    }
  }

  return {
    async listWorkspaces() {
      const [workspaces, extra] = await Promise.all([runtime.listWorkspaces(), herdrWorkspace()]);
      return extra ? [...workspaces, extra] : workspaces;
    },

    async getSnapshot(ref) {
      if (!isHerdrTerminalRef(ref)) return runtime.getSnapshot(ref);
      const id = herdr.resolve(ref);
      if (id === undefined) return undefined;
      const screen = await herdr.captureScreen(id, 2_000);
      return { terminalRef: ref, viewport: screen.viewport, scrollback: screen.scrollback, updatedAt: new Date().toISOString() };
    },

    async captureScreen(ref, lines) {
      if (!isHerdrTerminalRef(ref)) return runtime.captureScreen ? runtime.captureScreen(ref, lines) : null;
      const id = herdr.resolve(ref);
      if (id === undefined) return null;
      return herdr.captureScreen(id, lines);
    },

    async writeInput(ref, data, expectedIncarnation) {
      if (!isHerdrTerminalRef(ref)) return runtime.writeInput(ref, data, expectedIncarnation);
      const id = herdr.resolve(ref);
      if (id === undefined) throw new TerminalAgentVerbError("not_found");
      await herdr.writeInput(id, data);
    },

    async listAgentStatuses() {
      const [own, extra] = await Promise.all([
        runtime.listAgentStatuses ? runtime.listAgentStatuses() : Promise.resolve([]),
        herdr.statuses().catch((error: unknown) => { warn("status unavailable", error); return []; }),
      ]);
      return [...own, ...extra];
    },
  };
}

