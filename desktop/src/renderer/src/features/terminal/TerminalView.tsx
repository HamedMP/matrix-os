import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "../../design/primitives";
import { getThemeTerminalColors } from "../../design/themes";
import { resolveThemeMode } from "../../design/themes/apply";
import { useAppearance } from "../../stores/appearance";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { buildTerminalFontStack } from "../../lib/terminal/terminal-fonts";
import type { ActiveAttachment } from "./attach-manager";
import type { ShellSocketState } from "../../lib/shell-socket";
import { getAttachManager } from "./terminal-runtime";
import TerminalLinkContextMenu, { type DesktopTerminalLinkMenuState } from "./TerminalLinkContextMenu";
import {
  DesktopWebLinkProvider,
  activateDesktopTerminalLink,
  copyDesktopTerminalLink,
  findDesktopTerminalLinkAtPointer,
  openDesktopTerminalLink,
  resolveDesktopTerminalLink,
  type TerminalLinkEntry,
} from "./terminal-link-actions";
import {
  bracketTerminalPaths,
  MAX_TERMINAL_PASTE_FILE_BYTES,
  safeTerminalUploadFilename,
  terminalPasteFiles,
} from "./terminal-rich-paste";

const GAP_MARKER = "\r\n\x1b[2m── output gap ──\x1b[0m\r\n";
const RECENT_ACTIVITY_THROTTLE_MS = 30_000;

function applyTerminalSurfaceTheme(element: HTMLElement | undefined, background: string): void {
  if (!element) return;
  element.style.width = "100%";
  element.style.height = "100%";
  element.style.backgroundColor = background;
  for (const selector of [".xterm-viewport", ".xterm-scrollable-element"]) {
    const surface = element.querySelector<HTMLElement>(selector);
    if (surface) surface.style.backgroundColor = background;
  }
}

interface TerminalViewProps {
  sessionName: string;
  // When false, the xterm stays mounted (buffer preserved) but the live socket
  // is released so only the focused terminal holds a VPS attachment.
  active?: boolean;
  onRecreate?: () => void;
}

export default function TerminalView({ sessionName, active = true, onRecreate }: TerminalViewProps) {
  const api = useConnection((state) => state.api);
  const appearanceMode = useAppearance((state) => state.mode);
  const appearanceThemeId = useAppearance((state) => state.themeId);
  const terminalBackground = getThemeTerminalColors(
    appearanceThemeId,
    resolveThemeMode(appearanceMode),
  ).background;
  const hostRef = useRef<HTMLDivElement>(null);
  const [stateSessionName, setStateSessionName] = useState(sessionName);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const attachmentRef = useRef<ActiveAttachment | null>(null);
  const endedRef = useRef(false);
  const hoveredLinkRef = useRef<TerminalLinkEntry | null>(null);
  const [socketState, setSocketState] = useState<ShellSocketState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [linkContextMenu, setLinkContextMenu] = useState<DesktopTerminalLinkMenuState | null>(null);
  const closeLinkContextMenu = useCallback(() => setLinkContextMenu(null), []);
  const [pasteError, setPasteError] = useState<string | null>(null);

  if (stateSessionName !== sessionName) {
    setStateSessionName(sessionName);
    endedRef.current = false;
    setSocketState("connecting");
    setExitCode(null);
  }

  // xterm lifecycle — mount once, dispose only on real unmount (tab close).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const appearance = useAppearance.getState();
    const theme = getThemeTerminalColors(appearance.themeId, resolveThemeMode(appearance.mode));
    const screenReaderMode = navigator.webdriver === true;
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      // Playwright needs readable terminal text while WebGL is active.
      screenReaderMode,
      fontSize: 13,
      fontFamily: buildTerminalFontStack("JetBrains Mono", undefined),
      lineHeight: 1.25,
      scrollback: 5000,
      theme,
      linkHandler: {
        activate: activateDesktopTerminalLink,
        hover: (_event, text) => {
          hoveredLinkRef.current = resolveDesktopTerminalLink(text);
        },
        leave: () => {
          hoveredLinkRef.current = null;
        },
      },
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(serialize);
    terminal.open(host);
    applyTerminalSurfaceTheme(terminal.element, theme.background);
    const linkProviderDisposable = terminal.registerLinkProvider(
      new DesktopWebLinkProvider(terminal, (link) => {
        hoveredLinkRef.current = link;
      }),
    );
    const linkAtPointer = (event: MouseEvent): TerminalLinkEntry | null => {
      return findDesktopTerminalLinkAtPointer(
        terminal,
        event.clientX,
        event.clientY,
        hoveredLinkRef.current,
      );
    };
    const onLinkMouseUp = (event: MouseEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      const link = linkAtPointer(event);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 0) openDesktopTerminalLink(link);
    };
    const onLinkContextMenu = (event: MouseEvent) => {
      const link = linkAtPointer(event);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      setLinkContextMenu({ x: event.clientX, y: event.clientY, link });
    };
    host.addEventListener("mouseup", onLinkMouseUp, true);
    host.addEventListener("contextmenu", onLinkContextMenu);
    try {
      terminal.loadAddon(new WebglAddon());
    } catch (err: unknown) {
      console.warn("[terminal] webgl unavailable:", err instanceof Error ? err.message : String(err));
    }
    fit.fit();
    const cached = getAttachManager().getCachedBuffer(sessionName);
    if (cached) terminal.write(cached);
    termRef.current = terminal;
    fitRef.current = fit;
    serializeRef.current = serialize;

    // Restyle live terminals when the unified theme changes; unrelated store
    // writes (hydration) must not reassign the palette.
    const unsubscribeAppearance = useAppearance.subscribe((state, previous) => {
      if (state.themeId === previous.themeId && state.mode === previous.mode) return;
      const nextTheme = getThemeTerminalColors(state.themeId, resolveThemeMode(state.mode));
      terminal.options.theme = nextTheme;
      applyTerminalSurfaceTheme(terminal.element, nextTheme.background);
    });

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        fit.fit();
        attachmentRef.current?.resize(terminal.cols, terminal.rows);
      });
    });
    observer.observe(host);

    return () => {
      closeLinkContextMenu();
      hoveredLinkRef.current = null;
      host.removeEventListener("mouseup", onLinkMouseUp, true);
      host.removeEventListener("contextmenu", onLinkContextMenu);
      linkProviderDisposable.dispose();
      unsubscribeAppearance();
      observer.disconnect();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const manager = getAttachManager();
      try {
        manager.cacheBuffer(sessionName, serialize.serialize());
      } catch (err: unknown) {
        console.warn("[terminal] buffer snapshot failed:", err instanceof Error ? err.message : String(err));
      }
      if (manager.activeSessionName === sessionName) manager.detachActive();
      terminal.dispose();
      termRef.current = null;
    };
  }, [closeLinkContextMenu, sessionName]);

  // Attach lifecycle — only the active tab holds the live socket (L4).
  useEffect(() => {
    const terminal = termRef.current;
    const fit = fitRef.current;
    if (!terminal) return;
    if (!active) {
      terminal.blur();
      hoveredLinkRef.current = null;
      closeLinkContextMenu();
      return;
    }
    if (endedRef.current) return;

    const manager = getAttachManager();
    const attachment = manager.attach(sessionName, {
      onState: (state) => setSocketState(state),
      onOutput: (data) => terminal.write(data),
      onGap: () => {
        terminal.clear();
        terminal.write(GAP_MARKER);
      },
      onExit: (code) => {
        endedRef.current = true;
        setExitCode(code);
        setSocketState("ended");
      },
    });
    attachmentRef.current = attachment;
    let lastRecentActivityAt = 0;
    const dataDisposable = terminal.onData((data) => {
      const now = Date.now();
      if (now - lastRecentActivityAt >= RECENT_ACTIVITY_THROTTLE_MS) {
        lastRecentActivityAt = now;
        useTabs.getState().recordRecentTerminal(sessionName, sessionName);
      }
      attachment.write(data);
    });
    fit?.fit();
    attachment.resize(terminal.cols, terminal.rows);
    terminal.focus();

    return () => {
      dataDisposable.dispose();
      attachmentRef.current = null;
      if (manager.activeSessionName === sessionName) manager.detachActive();
    };
  }, [sessionName, active, closeLinkContextMenu]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    let cancelled = false;

    const filesForEvent = (event: ClipboardEvent | DragEvent) => terminalPasteFiles(
      "clipboardData" in event ? event.clipboardData : event.dataTransfer,
    );

    const captureFiles = (event: ClipboardEvent | DragEvent) => {
      const files = filesForEvent(event);
      if (files.length === 0) return [];
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return files;
    };

    const uploadAndPaste = async (files: ReturnType<typeof terminalPasteFiles>) => {
      if (files.some(({ file }) => file.size > MAX_TERMINAL_PASTE_FILE_BYTES)) {
        if (!cancelled) setPasteError("Images are limited to 10 MB.");
        return;
      }
      if (!api || !attachmentRef.current) {
        if (!cancelled) setPasteError("Image paste is unavailable. Reconnect and try again.");
        return;
      }
      try {
        const paths = await Promise.all(files.map(async ({ file, mimeType }) => {
          const response = await api.postBytes<{ terminalPath?: unknown }>(
            `/api/terminal/sessions/${encodeURIComponent(sessionName)}/paste-assets`,
            file,
            {
              "Content-Type": mimeType,
              "X-Matrix-Filename": safeTerminalUploadFilename(file.name),
            },
            { timeoutMs: 30_000 },
          );
          if (
            typeof response.terminalPath !== "string"
            || !response.terminalPath.startsWith("/home/matrix/home/")
            || /[\u0000\r\n]/.test(response.terminalPath)
          ) {
            throw new Error("invalid terminal paste response");
          }
          return response.terminalPath;
        }));
        if (paths.length === 0 || cancelled) return;
        const payload = bracketTerminalPaths(paths);
        if (payload === "\x1b[200~\x1b[201~") throw new Error("invalid terminal paste paths");
        attachmentRef.current?.write(payload);
        setPasteError(null);
      } catch (err: unknown) {
        console.warn("[terminal] image paste failed:", err instanceof Error ? err.message : String(err));
        if (!cancelled) setPasteError("Image paste failed. Try again.");
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      const files = captureFiles(event);
      if (files.length > 0) void uploadAndPaste(files);
    };
    const onDrag = (event: DragEvent) => {
      captureFiles(event);
    };
    const onDrop = (event: DragEvent) => {
      const files = captureFiles(event);
      if (files.length > 0) void uploadAndPaste(files);
    };

    host.addEventListener("paste", onPaste, { capture: true });
    host.addEventListener("dragenter", onDrag, { capture: true });
    host.addEventListener("dragover", onDrag, { capture: true });
    host.addEventListener("drop", onDrop, { capture: true });
    return () => {
      cancelled = true;
      host.removeEventListener("paste", onPaste, { capture: true });
      host.removeEventListener("dragenter", onDrag, { capture: true });
      host.removeEventListener("dragover", onDrag, { capture: true });
      host.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [active, api, sessionName]);

  const banner = (() => {
    if (socketState === "fatal") {
      return { text: "This session has ended on your computer.", action: onRecreate ? <Button variant="primary" onClick={onRecreate}>Start new session</Button> : null };
    }
    if (socketState === "ended") {
      return { text: exitCode !== null ? `Session exited (code ${exitCode}).` : "Session ended.", action: onRecreate ? <Button variant="primary" onClick={onRecreate}>Start new session</Button> : null };
    }
    if (socketState === "connection-lost") return { text: "Connection lost. Reconnecting…", action: null };
    return null;
  })();

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2"
      data-terminal-surface
      style={{ backgroundColor: terminalBackground }}
    >
      <div
        ref={hostRef}
        className="h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-terminal-viewport
        data-selectable
      />
      {pasteError ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3" aria-live="polite">
          <span className="rounded-md px-3 py-1.5 text-xs" style={{ background: "var(--danger-muted)", color: "var(--danger)" }}>
            {pasteError}
          </span>
        </div>
      ) : null}
      {active && (socketState === "connecting" || socketState === "reconnecting") ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-2" role="status" aria-live="polite">
          <span className="status-pulse rounded-full px-3 py-1 text-xs" style={{ background: "var(--bg-overlay)", color: "var(--text-secondary)" }}>
            {socketState === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
      ) : null}
      {banner ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t px-4 py-2.5" role="status" aria-live="polite" style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)" }}>
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{banner.text}</span>
          {banner.action}
        </div>
      ) : null}
      <TerminalLinkContextMenu
        menu={linkContextMenu}
        onClose={closeLinkContextMenu}
        onOpen={openDesktopTerminalLink}
        onCopy={copyDesktopTerminalLink}
      />
    </div>
  );
}
