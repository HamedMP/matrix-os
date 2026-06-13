import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "../../design/primitives";
import { getTerminalThemePreset } from "../../lib/terminal/terminal-themes";
import { buildTerminalFontStack } from "../../lib/terminal/terminal-fonts";
import type { ShellSocketState } from "../../lib/shell-socket";
import { getAttachManager } from "./terminal-runtime";

const GAP_MARKER = "\r\n\x1b[2m── output gap ──\x1b[0m\r\n";

interface TerminalViewProps {
  sessionName: string;
  onRecreate?: () => void;
}

export default function TerminalView({ sessionName, onRecreate }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stateSessionName, setStateSessionName] = useState(sessionName);
  const [socketState, setSocketState] = useState<ShellSocketState>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);

  if (stateSessionName !== sessionName) {
    setStateSessionName(sessionName);
    setSocketState("connecting");
    setExitCode(null);
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const manager = getAttachManager();
    const theme = getTerminalThemePreset("one-dark");
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      // Accessibility buffer (also lets e2e assert rendered output under webgl).
      screenReaderMode: true,
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
      console.warn(
        "[terminal] webgl renderer unavailable, falling back to canvas:",
        err instanceof Error ? err.message : String(err),
      );
    }
    fit.fit();

    const cached = manager.getCachedBuffer(sessionName);
    if (cached) terminal.write(cached);

    const attachment = manager.attach(sessionName, {
      onState: (state) => setSocketState(state),
      onOutput: (data) => terminal.write(data),
      onGap: () => {
        terminal.clear();
        terminal.write(GAP_MARKER);
      },
      onExit: (code) => {
        setExitCode(code);
        setSocketState("ended");
      },
    });

    const dataDisposable = terminal.onData((data) => attachment.write(data));

    const sendDims = () => {
      fit.fit();
      attachment.resize(terminal.cols, terminal.rows);
    };
    sendDims();
    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        sendDims();
      });
    });
    observer.observe(host);

    terminal.focus();

    return () => {
      observer.disconnect();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      dataDisposable.dispose();
      try {
        manager.cacheBuffer(sessionName, serialize.serialize());
      } catch (err: unknown) {
        console.warn(
          "[terminal] buffer snapshot failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (manager.activeSessionName === sessionName) manager.detachActive();
      terminal.dispose();
    };
  }, [sessionName]);

  const banner = (() => {
    if (socketState === "fatal") {
      return {
        text: "This session has ended on your computer.",
        action: onRecreate ? <Button variant="primary" onClick={onRecreate}>Start new session</Button> : null,
      };
    }
    if (socketState === "ended") {
      return {
        text: exitCode !== null ? `Session exited (code ${exitCode}).` : "Session ended.",
        action: onRecreate ? <Button variant="primary" onClick={onRecreate}>Start new session</Button> : null,
      };
    }
    if (socketState === "connection-lost") {
      return { text: "Connection lost. Reconnecting…", action: null };
    }
    return null;
  })();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={{ background: "#0d1017" }}>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 pt-1.5" data-selectable />
      {socketState === "connecting" || socketState === "reconnecting" ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-2"
          aria-live="polite"
        >
          <span
            className="status-pulse rounded-full px-3 py-1 text-xs"
            style={{ background: "var(--bg-overlay)", color: "var(--text-secondary)" }}
          >
            {socketState === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
      ) : null}
      {banner ? (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t px-4 py-2.5"
          style={{
            background: "var(--bg-overlay)",
            borderColor: "var(--border-default)",
          }}
        >
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {banner.text}
          </span>
          {banner.action}
        </div>
      ) : null}
    </div>
  );
}
