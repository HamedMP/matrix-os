import { useEffect, useMemo, useState } from "react";
import { z } from "zod/v4";
import { desktopLinkWorkspaceId, DESKTOP_LINK_CLIENT_TIMEOUT_MS } from "@matrix-os/contracts/desktop-link";
import { DesktopMachinesGroup, useDesktopMachines, type DesktopLinkRequest } from "@matrix-os/ui/desktop-link";

import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import type { ShellSessionSummary } from "../../stores/shell-sessions";
import { invoke, onEvent } from "../../lib/operator";

const ThisDeviceSchema = z.strictObject({ deviceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20) });
const NONE: readonly string[] = [];

/**
 * This device's own device ids, so its own views leave it out of the computer's
 * desktops. Read again when the link changes (pairing from the Terminal window)
 * and whenever `refreshKey` does, such as when the desktops listed change.
 */
export function useThisDevice(refreshKey = ""): readonly string[] {
  const [deviceIds, setDeviceIds] = useState<readonly string[]>(NONE);
  const [changes, setChanges] = useState(0);
  useEffect(() => onEvent("desktop-link:changed", () => setChanges((count) => count + 1)), []);
  useEffect(() => {
    let live = true;
    invoke("desktop-link:this-device", {}).then(
      (reply) => {
        const parsed = ThisDeviceSchema.safeParse(reply);
        if (live && parsed.success) setDeviceIds(parsed.data.deviceIds);
      },
      (error: unknown) => { console.warn("[desktop-link] this-device failed", error instanceof Error ? error.name : "unknown_error"); },
    );
    return () => { live = false; };
  }, [refreshKey, changes]);
  return deviceIds;
}

/** A failed answer as the status the shared client reads; its body never reaches the UI. */
function asResponse(error: unknown): Response {
  if (error instanceof AppError && typeof error.httpStatus === "number") return new Response("{}", { status: error.httpStatus });
  throw error;
}

/** The computer's `/api/desktop-link` through the signed-in API client, bounded like every desktop request. */
export function desktopLinkRequest(api: ApiClient): DesktopLinkRequest {
  return (path, init) => {
    // A start may wait for the owner's approval on the desktop: never cut short by the
    // client's 10 s default before the shared client's own deadline (spec 2716, D2).
    const options = { signal: init.signal, timeoutMs: DESKTOP_LINK_CLIENT_TIMEOUT_MS, ...(init.headers ? { headers: init.headers } : {}) };
    if (init.method === "GET") return api.getText(path, options).then((text) => new Response(text), asResponse);
    // The shared client sends only bodies it built itself: `{}`, `{ agent }` or `{ revision }`.
    const body: unknown = init.body ? JSON.parse(init.body) : {};
    const call = init.method === "POST" ? api.post(path, body, options) : api.delete(path, body, options);
    return call.then((reply) => new Response(JSON.stringify(reply ?? {})), asResponse);
  };
}

/** A terminal on a linked desktop as a Terminal session row, opened through the same view as every Matrix tab. */
export function electronDesktopSession(deviceId: string, session: { tabId: string; title: string }): ShellSessionSummary {
  const workspaceId = desktopLinkWorkspaceId(deviceId);
  return {
    name: `${workspaceId}:${session.tabId}`,
    workspaceId,
    tabId: session.tabId,
    revision: 0,
    workspaceRevision: 0,
    cwd: "~",
    subtitle: session.title,
    status: "active",
    placement: "active",
  };
}

/** "Desktops" after Herdr sessions in the Electron Desktop Terminal (spec 2716). */
export function ElectronDesktopMachines({ api, selectedName, onOpen }: {
  api: ApiClient | null;
  selectedName: string | null;
  onOpen(shell: ShellSessionSummary): void;
}) {
  const request = useMemo(() => (api ? desktopLinkRequest(api) : null), [api]);
  const desktops = useDesktopMachines({ request });
  // A device paired while this view is open shows up in the list: read this device's ids again then.
  const listed = desktops.desktops.machines.map((machine) => machine.deviceId).join(",");
  const thisDevice = useThisDevice(listed);
  return (
    <DesktopMachinesGroup
      state={desktops}
      hideDeviceIds={thisDevice}
      selectedRefKey={selectedName}
      onOpen={(deviceId, session) => onOpen(electronDesktopSession(deviceId, session))}
      style={{ color: "var(--text-primary)", maxHeight: "40%", overflowY: "auto" }}
    />
  );
}
