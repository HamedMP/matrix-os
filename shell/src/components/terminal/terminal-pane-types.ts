import type { Theme } from "@/hooks/useTheme";
import type { TerminalCompatMode } from "@/stores/terminal-store";

export interface TerminalPaneProps {
  paneId: string;
  cwd: string;
  theme: Theme;
  isFocused: boolean;
  focusRequestId?: number;
  sessionId?: string;
  claudeMode?: boolean;
  startupCommand?: string;
  compatMode?: TerminalCompatMode;
  onFocus?: (paneId: string) => void;
  onSessionAttached?: (paneId: string, sessionId: string) => void;
  isClosing?: boolean;
  shouldCacheOnUnmount?: (paneId: string) => boolean;
  shouldDestroyOnUnmount?: (paneId: string) => boolean;
  allowRemoteResize?: boolean;
  suppressNativeKeyboard?: boolean;
  /**
   * The CSS transform scale applied to the canvas ancestor. When the canvas is
   * zoomed via `transform: scale(z)`, xterm's mouse-to-cell mapping breaks
   * because getBoundingClientRect() returns scaled screen pixels while
   * cssCellWidth is measured at the unscaled font size. Providing the live zoom
   * factor allows TerminalPane to correct pointer events before xterm sees them.
   * Defaults to 1 (no correction).
   */
  canvasZoom?: number;
}
