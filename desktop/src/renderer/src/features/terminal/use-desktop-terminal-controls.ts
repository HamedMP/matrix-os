import { useCallback, useMemo, type RefObject } from "react";
import { useTerminalControls, type TerminalControlsTransport } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import type { ShellSocketState } from "../../lib/shell-socket";
import type { ActiveAttachment } from "./attach-manager";

interface DesktopTerminalControlsOptions {
  api: ApiClient | null;
  sessionName: string;
  chatId?: string;
  active: boolean;
  socketState: ShellSocketState;
  leaseRevoked: boolean;
  isMac: boolean;
  attachmentRef: RefObject<ActiveAttachment | null>;
  termRef: RefObject<{ focus(): void } | null>;
}

/** Keep the renderer's authenticated transport outside shared terminal behavior. */
export function useDesktopTerminalControls({
  api,
  sessionName,
  chatId,
  active,
  socketState,
  leaseRevoked,
  isMac,
  attachmentRef,
  termRef,
}: DesktopTerminalControlsOptions) {
  const transport = useMemo<TerminalControlsTransport | null>(() => api ? {
    getPreferences: () => api.get("/api/terminal/preferences"),
    savePreferences: (keyboard) => api.put("/api/terminal/preferences", { keyboard }),
    paneAction: (name, action) => api.post(
      `/api/terminal/sessions/${encodeURIComponent(name)}/pane-actions${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ""}`,
      action,
    ),
  } : null, [api, chatId]);
  const enabled = active && socketState === "attached" && !leaseRevoked && api !== null;
  const sendInput = useCallback((data: string) => {
    const attachment = attachmentRef.current;
    if (enabled && attachment?.sessionName === sessionName) attachment.write(data);
  }, [attachmentRef, enabled, sessionName]);
  const focus = useCallback(() => {
    if (active) termRef.current?.focus();
  }, [active, termRef]);
  return useTerminalControls({ sessionName, enabled, isMac, transport, sendInput, focus });
}
