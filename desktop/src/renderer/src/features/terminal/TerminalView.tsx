import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "../../design/primitives";
import { getThemeTerminalColors } from "../../design/themes";
import { resolveThemeMode } from "../../design/themes/apply";
import { useAppearance } from "../../stores/appearance";
import { useConnection } from "../../stores/connection";
import { buildTerminalFontStack } from "../../lib/terminal/terminal-fonts";
import type { ActiveAttachment } from "./attach-manager";
import type { ShellSocketState } from "../../lib/shell-socket";
import { getAttachManager } from "./terminal-runtime";
import {
  bracketTerminalPaths,
  MAX_TERMINAL_PASTE_FILE_BYTES,
  safeTerminalUploadFilename,
  terminalPasteFiles,
} from "./terminal-rich-paste";

const GAP_MARKER = "\r\n\x1b[2m── output gap ──\x1b[0m\r\n";

interface TerminalViewProps {
  sessionName: string;
  // When false, the xterm stays mounted (buffer preserved) but the live socket
  // is released so only the focused terminal holds a VPS attachment.
  active?: boolean;
  onRecreate?: () => void;
}

export default function TerminalView({ sessionName, active = true, onRecreate }: TerminalViewProps) {
  const api = useConnection((state) => state.api);
  const hostRef = useRef<HTMLDivElement>(null);
  const [stateSessionName, setStateSessionName] = useState(sessionName);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const attachmentRef = useRef<ActiveAttachment | null>(null);
  const endedRef = useRef(false);
  const [socketState, setSocketState] = useState<ShellSocketState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
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
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(serialize);
    terminal.open(host);
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
      terminal.options.theme = getThemeTerminalColors(state.themeId, resolveThemeMode(state.mode));
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
  }, [sessionName]);

  // Attach lifecycle — only the active tab holds the live socket (L4).
  useEffect(() => {
    const terminal = termRef.current;
    const fit = fitRef.current;
    if (!terminal || !active || endedRef.current) return;

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
    const dataDisposable = terminal.onData((data) => attachment.write(data));
    fit?.fit();
    attachment.resize(terminal.cols, terminal.rows);
    terminal.focus();

    return () => {
      dataDisposable.dispose();
      attachmentRef.current = null;
      if (manager.activeSessionName === sessionName) manager.detachActive();
    };
  }, [sessionName, active]);

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
      } catch {
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
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ background: "#0d1017" }}>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 pt-1.5" data-terminal-viewport data-selectable />
      {pasteError ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3" aria-live="polite">
          <span className="rounded-md px-3 py-1.5 text-xs" style={{ background: "var(--danger-muted)", color: "var(--danger)" }}>
            {pasteError}
          </span>
        </div>
      ) : null}
      {active && (socketState === "connecting" || socketState === "reconnecting") ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-2" aria-live="polite">
          <span className="status-pulse rounded-full px-3 py-1 text-xs" style={{ background: "var(--bg-overlay)", color: "var(--text-secondary)" }}>
            {socketState === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
      ) : null}
      {banner ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t px-4 py-2.5" style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)" }}>
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{banner.text}</span>
          {banner.action}
        </div>
      ) : null}
    </div>
  );
}
