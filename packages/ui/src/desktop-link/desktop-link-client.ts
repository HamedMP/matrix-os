// The owner's linked desktops for every OS view (spec 2716): one client over the
// computer gateway's `/api/desktop-link`, so Web Canvas, Web Desktop and Electron
// Desktop derive the same desktops group from the same responses.
import { z } from "zod/v4";
import { HerdrSessionSchema, type HerdrSession } from "@matrix-os/contracts/herdr-terminals";
import { desktopPairingRevisionTag } from "@matrix-os/contracts";
import {
  DESKTOP_LINK_CLIENT_TIMEOUT_MS, DesktopLinkMachineListSchema, desktopLinkWorkspaceId, type DesktopLinkMachine,
} from "@matrix-os/contracts/desktop-link";

export const DESKTOP_LINK_API = "/api/desktop-link";
const MAX_RESPONSE_CHARS = 512 * 1024;
const TIMEOUT_MS = 10_000;

/** An authenticated gateway request; each surface supplies its own transport. */
export type DesktopLinkRequest = (path: string, init: {
  method: "GET" | "POST" | "DELETE";
  signal: AbortSignal;
  body?: string;
  headers?: Record<string, string>;
}) => Promise<Response>;

export type DesktopAgent = "claude" | "codex" | "opencode" | "pi";

export class DesktopLinkRequestError extends Error {
  constructor(readonly code: "offline" | "denied" | "busy" | "failed") {
    super("desktop request failed");
    this.name = "DesktopLinkRequestError";
  }
}

export interface DesktopMachines { machineId: string | null; machines: DesktopLinkMachine[] }
export const NO_DESKTOPS: DesktopMachines = { machineId: null, machines: [] };

const TerminalsSchema = z.object({
  workspaceId: z.string().regex(/^tws_[0-9a-f]{32}$/),
  sessions: z.array(HerdrSessionSchema).max(500),
});
export interface DesktopTerminals { workspaceId: string; sessions: HerdrSession[] }

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) return null;
  try { return JSON.parse(text); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function failure(response: Response, body: unknown): DesktopLinkRequestError {
  const code = (body as { error?: unknown } | null)?.error;
  if (code === "desktop_offline" || response.status === 503) return new DesktopLinkRequestError("offline");
  if (code === "denied" || response.status === 403) return new DesktopLinkRequestError("denied");
  if (code === "busy" || response.status === 429) return new DesktopLinkRequestError("busy");
  return new DesktopLinkRequestError("failed");
}

/** The desktop paired with this computer, or none when the gateway cannot say (no desktops UI then). */
export async function loadDesktopMachines(request: DesktopLinkRequest): Promise<DesktopMachines> {
  const response = await request(`${DESKTOP_LINK_API}/machines`, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return NO_DESKTOPS;
  const parsed = DesktopLinkMachineListSchema.safeParse(await readJson(response));
  return parsed.success ? parsed.data : NO_DESKTOPS;
}

export async function loadDesktopTerminals(request: DesktopLinkRequest, deviceId: string): Promise<DesktopTerminals> {
  const response = await request(`${DESKTOP_LINK_API}/machines/${deviceId}/terminals`, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await readJson(response);
  if (!response.ok) throw failure(response, body);
  const parsed = TerminalsSchema.safeParse(body);
  if (!parsed.success) throw new DesktopLinkRequestError("failed");
  return parsed.data;
}

export interface StartedDesktopTerminal { id: string; tabId: string }

/** Starts the desktop user's shell, or an agent preset, at home. Returns the terminal and the tab id it opens by. */
export async function startDesktopTerminal(request: DesktopLinkRequest, deviceId: string, agent?: DesktopAgent): Promise<StartedDesktopTerminal> {
  // May wait for the owner's approval on the desktop (spec 2716, D2).
  const response = await request(`${DESKTOP_LINK_API}/machines/${deviceId}/terminals`, {
    method: "POST", signal: AbortSignal.timeout(DESKTOP_LINK_CLIENT_TIMEOUT_MS),
    headers: { "content-type": "application/json" }, body: JSON.stringify(agent ? { agent } : {}),
  });
  const body = await readJson(response);
  if (!response.ok) throw failure(response, body);
  const { id, tabId } = (body ?? {}) as { id?: unknown; tabId?: unknown };
  if (typeof id !== "string" || !/^t[0-9]{1,6}[a-z]{0,2}$/.test(id)) throw new DesktopLinkRequestError("failed");
  if (typeof tabId !== "string" || !/^tt_[0-9a-f]{32}$/.test(tabId)) throw new DesktopLinkRequestError("failed");
  return { id, tabId };
}

export async function closeDesktopTerminal(request: DesktopLinkRequest, deviceId: string, id: string): Promise<void> {
  const response = await request(`${DESKTOP_LINK_API}/machines/${deviceId}/terminals/${id}`, {
    method: "DELETE", signal: AbortSignal.timeout(DESKTOP_LINK_CLIENT_TIMEOUT_MS),
  });
  if (!response.ok) throw failure(response, await readJson(response));
}

/**
 * Removes the desktop from this computer by disconnecting its 2698 pairing at
 * this revision: its link closes at once and it must be paired again on the desktop.
 */
export async function removeDesktop(request: DesktopLinkRequest, machineId: string, machine: Pick<DesktopLinkMachine, "deviceId" | "revision">): Promise<void> {
  const response = await request(`/api/desktop-pairing/${machine.deviceId}`, {
    method: "DELETE", signal: AbortSignal.timeout(TIMEOUT_MS), body: JSON.stringify({ revision: machine.revision }),
    headers: {
      "content-type": "application/json",
      "If-Match": desktopPairingRevisionTag({ machineId, deviceId: machine.deviceId, revision: machine.revision }),
    },
  });
  if (!response.ok) throw failure(response, await readJson(response));
}

/** The terminal ref key (`workspaceId:tabId`) a Matrix terminal view opens for a desktop terminal. */
export function desktopTerminalRefKey(deviceId: string, session: Pick<HerdrSession, "tabId">): string {
  return `${desktopLinkWorkspaceId(deviceId)}:${session.tabId}`;
}

export type { DesktopLinkMachine };
