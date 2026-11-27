// Terminals on linked desktops in 2692's terminal verbs, waits, events and the
// kernel's tools (spec 2716): each linked desktop is one more workspace, with its
// own workspace id, so `terminal_list` shows it and `read`, `send`, `keys`,
// `interrupt` and `wait` reach it. Reads and writes for a desktop ref go to that
// desktop's Herdr adapter, through the desktop's guard; everything else is unchanged.
import type { TerminalRef, TerminalWorkspace } from "@matrix-os/contracts";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { desktopLinkDevicePrefix, desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import type { TerminalAgentStatusEntry } from "@matrix-os/terminal-runtime";
import { TerminalAgentVerbError } from "../terminal-agent/verbs.js";
import type { TerminalAgentPipelineRuntime } from "../herdr/verb-runtime.js";
import type { HerdrAdapter } from "../herdr/adapter.js";

/** What the pipeline needs from the Desktop link: the desktops linked right now. */
export interface DesktopTerminalSource {
  linked(): Array<{ deviceId: string; name: string; adapter: HerdrAdapter }>;
}

function warn(message: string, error: unknown): void {
  console.warn(`[desktop-link] ${message}`, error instanceof Error ? error.name : "unknown_error");
}

/** A desktop's terminals as one workspace under that desktop's own id. */
function asDesktopWorkspace(workspace: TerminalWorkspace, deviceId: string): TerminalWorkspace {
  const id = desktopLinkWorkspaceId(deviceId);
  return { ...workspace, id, tabs: workspace.tabs.map((tab) => ({ ...tab, workspaceId: id })) };
}

/**
 * How long the computer's own terminal listing waits on a linked desktop. A
 * half-open link, or a desktop waiting on its owner, never stalls the computer's
 * own terminals: past this the desktop's terminals are left out of that listing.
 */
export const DESKTOP_LISTING_DEADLINE_MS = 3_000;

function withinListingDeadline<T>(work: Promise<T>, fallback: T, ms = DESKTOP_LISTING_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); });
  // The desktop's own answer, if it comes later, is dropped; its failure is still logged by the caller's catch.
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function withDesktopTerminals(
  runtime: TerminalAgentPipelineRuntime,
  desktops: DesktopTerminalSource,
): Required<Pick<TerminalAgentPipelineRuntime, "listAgentStatuses" | "captureScreen">> & TerminalAgentPipelineRuntime {
  /** The desktop a ref names and the Herdr ref its adapter knows it by, or null for any other ref. */
  function target(ref: TerminalRef): { adapter: HerdrAdapter; herdrRef: TerminalRef } | null {
    const prefix = desktopLinkDevicePrefix(ref.workspaceId);
    if (!prefix) return null;
    const matches = desktops.linked().filter((mac) => mac.deviceId.startsWith(prefix));
    // An offline desktop, or (never in practice) two with one prefix: nothing to reach.
    if (matches.length !== 1) throw new TerminalAgentVerbError("not_found");
    return { adapter: matches[0]!.adapter, herdrRef: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: ref.tabId } };
  }

  async function desktopWorkspaces(): Promise<TerminalWorkspace[]> {
    const listed = await Promise.all(desktops.linked().map(async (mac) => {
      try {
        const workspace = await withinListingDeadline(mac.adapter.workspace(), null);
        return workspace ? asDesktopWorkspace(workspace, mac.deviceId) : null;
      } catch (error: unknown) {
        // A desktop that cannot be read now hides its terminals, never anyone else's.
        warn("desktop terminal listing unavailable", error);
        return null;
      }
    }));
    return listed.filter((workspace): workspace is TerminalWorkspace => workspace !== null);
  }

  const capture = runtime.captureScreen?.bind(runtime);
  const statuses = runtime.listAgentStatuses?.bind(runtime);

  return {
    ...runtime,
    async listWorkspaces() {
      const [own, extra] = await Promise.all([
        runtime.listWorkspaces().then((workspaces) => ({ ok: true as const, workspaces }), (error: unknown) => ({ ok: false as const, error })),
        desktopWorkspaces(),
      ]);
      if (own.ok) return [...own.workspaces, ...extra];
      // A linked desktop does not depend on this computer's terminal runtime: while
      // that runtime is down, the desktop's terminals stay reachable. With no
      // desktop linked, the runtime's own failure is the answer.
      if (extra.length === 0) throw own.error;
      warn("terminal runtime unavailable; listing linked desktops only", own.error);
      return extra;
    },

    async getSnapshot(ref) {
      const mac = target(ref);
      if (!mac) return runtime.getSnapshot(ref);
      const id = mac.adapter.resolve(mac.herdrRef);
      if (id === undefined) return undefined;
      const screen = await mac.adapter.captureScreen(id, 2_000);
      return { terminalRef: ref, viewport: screen.viewport, scrollback: screen.scrollback, updatedAt: new Date().toISOString() };
    },

    async captureScreen(ref, lines) {
      const mac = target(ref);
      if (!mac) return capture ? capture(ref, lines) : null;
      const id = mac.adapter.resolve(mac.herdrRef);
      return id === undefined ? null : mac.adapter.captureScreen(id, lines);
    },

    async writeInput(ref, data, expectedIncarnation) {
      const mac = target(ref);
      if (!mac) return runtime.writeInput(ref, data, expectedIncarnation);
      const id = mac.adapter.resolve(mac.herdrRef);
      if (id === undefined) throw new TerminalAgentVerbError("not_found");
      await mac.adapter.writeInput(id, data);
    },

    async listAgentStatuses() {
      // This computer's runtime failing must not hide the desktops' statuses, as in listWorkspaces.
      const [own, extra] = await Promise.all([
        (statuses ? statuses() : Promise.resolve([] as TerminalAgentStatusEntry[])).catch((error: unknown) => {
          warn("terminal status unavailable", error);
          return [] as TerminalAgentStatusEntry[];
        }),
        Promise.all(desktops.linked().map(async (mac) => {
          try {
            return (await withinListingDeadline(mac.adapter.statuses(), [])).map((entry) => ({
              ...entry,
              ref: { ...entry.ref, workspaceId: desktopLinkWorkspaceId(mac.deviceId) },
            }));
          } catch (error: unknown) {
            warn("desktop status unavailable", error);
            return [];
          }
        })),
      ]);
      return [...own, ...extra.flat()];
    },
  };
}
