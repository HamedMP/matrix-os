// The kernel's view of linked desktops (spec 2716): which desktops are linked now, and
// starting a terminal on one. Reading, typing, keys, interrupt and waits use
// the ordinary terminal tools with the desktop terminal's ref, through the same
// pipeline. The kernel acts as the computer's owner, as the owner-only routes do.
import { desktopLinkWorkspaceId, type DesktopLinkDeviceInfo } from "@matrix-os/contracts/desktop-link";
import { HcCallError } from "@matrix-os/herdr-core-client/client";
import { HerdrAdapterError } from "../herdr/adapter.js";
import { herdrTabId } from "../herdr/refs.js";
import { TerminalAgentVerbError } from "../terminal-agent/verbs.js";
import { DESKTOP_LINK_AGENT_LINES } from "./terminal-routes.js";
import { DesktopCaptureError } from "./link.js";
import type { DesktopTerminalSource } from "./verb-runtime.js";

export interface DesktopKernelSource extends DesktopTerminalSource {
  allowRun(deviceId: string): boolean;
  capture(deviceId: string): Promise<Buffer>;
}

export type DesktopAgentName = keyof typeof DESKTOP_LINK_AGENT_LINES;

export interface DesktopRunInput {
  machine?: string;
  agent?: DesktopAgentName;
  argv?: string[];
  cwd?: string;
  name?: string;
}

function coded(code: string): Error {
  return Object.assign(new Error(`desktop terminal ${code}`), { code });
}

export function desktopKernelTools(source: DesktopKernelSource, ownerId: () => string) {
  /** One desktop by name (case-insensitive), or the only one when none is named. */
  function pick(machine: string | undefined) {
    const linked = source.linked();
    const wanted = machine?.trim().toLowerCase();
    const matches = wanted ? linked.filter((mac) => mac.name.toLowerCase() === wanted) : linked;
    if (matches.length === 0) throw coded(linked.length === 0 ? "no_desktop_linked" : "desktop_not_found");
    if (matches.length > 1) throw coded("name_the_desktop");
    return matches[0]!;
  }

  return {
    async desktops(): Promise<Array<{ machine: string; workspaceId: string } & DesktopLinkDeviceInfo>> {
      ownerId();
      return source.linked().map((desktop) => ({
        machine: desktop.name, workspaceId: desktopLinkWorkspaceId(desktop.deviceId), ...desktop.device,
      }));
    },

    /** A screenshot of the desktop's screen, as base64 JPEG for the model to look at. */
    async desktopScreenshot(input: { machine?: string }): Promise<{ machine: string; mimeType: "image/jpeg"; data: string }> {
      ownerId();
      const desktop = pick(input.machine);
      if (!desktop.device.capabilities.screenshot) throw coded("screenshot_unavailable");
      try {
        const image = await source.capture(desktop.deviceId);
        return { machine: desktop.name, mimeType: "image/jpeg", data: image.toString("base64") };
      } catch (error: unknown) {
        if (error instanceof DesktopCaptureError) {
          if (error.code === "declined") throw coded("denied");
          throw coded(error.code === "permission" ? "screen_recording_not_allowed" : `screenshot_${error.code}`);
        }
        throw error;
      }
    },

    async desktopRun(input: DesktopRunInput): Promise<{ machine: string; workspaceId: string; tabId: string }> {
      ownerId();
      if (input.agent && input.argv) throw coded("invalid_request");
      const mac = pick(input.machine);
      if (!mac.device.capabilities.terminals) throw coded("no_terminals");
      if (!source.allowRun(mac.deviceId)) throw coded("busy");
      let id: string | null;
      try {
        id = await mac.adapter.create({ cols: 120, rows: 36 }, {
          ...(input.agent ? { line: DESKTOP_LINK_AGENT_LINES[input.agent] } : {}),
          ...(input.argv ? { argv: input.argv } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.name ? { name: input.name } : {}),
        });
      } catch (error: unknown) {
        // The desktop's guard refused it (a folder outside home), or the desktop went away.
        if (error instanceof HcCallError) throw coded("denied");
        if (error instanceof HerdrAdapterError || error instanceof TerminalAgentVerbError) throw coded("desktop_offline");
        throw error;
      }
      if (!id) throw coded("busy");
      return { machine: mac.name, workspaceId: desktopLinkWorkspaceId(mac.deviceId), tabId: herdrTabId(id) };
    },
  };
}
