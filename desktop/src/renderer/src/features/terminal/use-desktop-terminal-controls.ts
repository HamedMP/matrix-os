import { AppError } from "../../../../shared/app-error";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  dispatchTerminalPaneRequest,
  useTerminalControls,
  type TerminalControlsTransport,
} from "@matrix-os/ui";
import type { TerminalPaneAction } from "@matrix-os/contracts";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import type { ApiClient } from "../../lib/api";
import type { ShellSocketState } from "../../lib/shell-socket";
import type { ActiveAttachment } from "./attach-manager";

interface DesktopTerminalControlsOptions {
  api: ApiClient | null;
  sessionName: string;
  chatId?: string;
  active: boolean;
  /** Whether this terminal holds the keyboard; defaults to `active`. Panes stay active while another is focused. */
  focused?: boolean;
  socketState: ShellSocketState;
  writable: boolean;
  isMac: boolean;
  attachmentRef: RefObject<ActiveAttachment | null>;
  termRef: RefObject<{ focus(): void; scrollToTop(): void; scrollToBottom(): void } | null>;
  /**
   * Pane actions handled by the host instead of the computer's Zellij panes
   * (the Terminal window's own split tree, spec 2706). Scrolling still goes
   * to the computer when there is one.
   */
  onPaneAction?: (action: TerminalPaneAction) => void;
}

/** Keep the renderer's authenticated transport outside shared terminal behavior. */
export function useDesktopTerminalControls({
  api,
  sessionName,
  chatId,
  active,
  focused,
  socketState,
  writable,
  isMac,
  attachmentRef,
  termRef,
  onPaneAction,
}: DesktopTerminalControlsOptions) {
  // The latest host callback, read when an action runs: a new callback on each
  // redraw must not rebuild the transport (that reloads preferences and drops a Ctrl+G prefix).
  const onPaneActionRef = useRef(onPaneAction);
  useEffect(() => { onPaneActionRef.current = onPaneAction; }, [onPaneAction]);
  const hostsPanes = onPaneAction !== undefined;
  const local = sessionName.startsWith("local:");
  // A Herdr terminal has no Matrix workspace, so the computer's pane routes cannot act on it.
  const herdr = sessionName.startsWith(`${HERDR_TERMINAL_WORKSPACE_ID}:`);
  const transport = useMemo<TerminalControlsTransport | null>(
    () => {
      const computer: TerminalControlsTransport | null = api
        ? {
            getPreferences: () => api.get("/api/terminal/preferences"),
            savePreferences: (keyboard) =>
              api.put("/api/terminal/preferences", { keyboard }),
            paneAction: (sessionName, action) =>
              dispatchTerminalPaneRequest({
                post: (path, body) => api.post(path, body),
                isMissingRoute: (error) =>
                  error instanceof AppError &&
                  error.category === "notFound" &&
                  error.detail === undefined,
                sessionName,
                chatId,
                action,
              }),
          }
        : null;
      if (!hostsPanes) return computer;
      return {
        getPreferences: computer?.getPreferences ?? (async () => ({ preferences: { keyboard: { profile: "mac", overrides: {} } } })),
        savePreferences: computer?.savePreferences ?? (async () => { throw new AppError("server"); }),
        paneAction: async (session, action) => {
          if (action.type === "scroll") {
            // A local or Herdr terminal's history is in its own xterm; a computer's is on the computer.
            if (local || herdr) {
              if (action.edge === "top") termRef.current?.scrollToTop();
              else termRef.current?.scrollToBottom();
              return undefined;
            }
            if (computer) return computer.paneAction(session, action);
            return undefined;
          }
          onPaneActionRef.current?.(action);
          return undefined;
        },
      };
    },
    [api, chatId, herdr, hostsPanes, local, termRef],
  );
  const enabled = active && writable && socketState === "attached" && (api !== null || hostsPanes);
  const sendInput = useCallback(
    (data: string) => {
      const attachment = attachmentRef.current;
      if (enabled && attachment?.sessionName === sessionName)
        attachment.write(data);
    },
    [attachmentRef, enabled, sessionName],
  );
  // Read when an action settles: a pane the person left meanwhile must not take the keyboard back.
  const holdsKeyboardRef = useRef(focused ?? active);
  useEffect(() => { holdsKeyboardRef.current = focused ?? active; }, [active, focused]);
  const focus = useCallback(() => {
    if (active && holdsKeyboardRef.current) termRef.current?.focus();
  }, [active, termRef]);
  return useTerminalControls({
    sessionName,
    enabled,
    // The Terminal window's own panes can split, zoom and close a Herdr pane; Zellij cannot.
    paneActionsEnabled: hostsPanes || !herdr,
    isMac,
    transport,
    sendInput,
    focus,
  });
}
