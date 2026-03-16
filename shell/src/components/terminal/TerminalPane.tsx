"use client";

import { useEffect, useRef, useCallback } from "react";
import { getGatewayWs } from "@/lib/gateway";
import type { Theme } from "@/hooks/useTheme";

const DARK_ANSI = {
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

const LIGHT_ANSI = {
  black: "#383a42",
  red: "#e45649",
  green: "#50a14f",
  yellow: "#c18401",
  blue: "#4078f2",
  magenta: "#a626a4",
  cyan: "#0184bc",
  white: "#a0a1a7",
  brightBlack: "#696c77",
  brightRed: "#e45649",
  brightGreen: "#50a14f",
  brightYellow: "#c18401",
  brightBlue: "#4078f2",
  brightMagenta: "#a626a4",
  brightCyan: "#0184bc",
  brightWhite: "#fafafa",
};

function inferMode(bg: string): "light" | "dark" {
  const hex = bg.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

function buildXtermTheme(theme: Theme) {
  const bg = theme.colors.background || "#1a1a2e";
  const fg = theme.colors.foreground || "#e0e0e0";
  const mode = theme.mode ?? inferMode(bg);
  const ansi = mode === "dark" ? DARK_ANSI : LIGHT_ANSI;

  return {
    background: bg,
    foreground: fg,
    cursor: theme.colors.primary || "#c2703a",
    selectionBackground: (theme.colors.primary || "#c2703a") + "44",
    ...ansi,
  };
}

interface TerminalPaneProps {
  paneId: string;
  cwd: string;
  theme: Theme;
  isFocused: boolean;
  claudeMode?: boolean;
  onFocus?: (paneId: string) => void;
}

export function TerminalPane({ paneId, cwd, theme, isFocused, claudeMode, onFocus }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<unknown>(null);
  const fitAddonRef = useRef<unknown>(null);

  const handleFocus = useCallback(() => {
    onFocus?.(paneId);
  }, [paneId, onFocus]);

  useEffect(() => {
    let disposed = false;

    async function init() {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      if (disposed || !containerRef.current) return;

      const xtermTheme = buildXtermTheme(theme);

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: theme.fonts?.mono || "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: xtermTheme,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      const baseWs = getGatewayWs().replace("/ws", "/ws/terminal");
      const wsUrl = cwd ? `${baseWs}?cwd=${encodeURIComponent(cwd)}` : baseWs;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        if (claudeMode) {
          setTimeout(() => {
            ws.send(JSON.stringify({ type: "input", data: "claude\r" }));
          }, 100);
        }
      };

      ws.onerror = () => {
        term.write("\r\n\x1b[31mConnection error. Is the gateway running?\x1b[0m\r\n");
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
          if (msg.type === "output") {
            term.write(msg.data);
          } else if (msg.type === "exit") {
            term.write("\r\n[Process exited]\r\n");
          }
        } catch {
          // ignore
        }
      };

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        resizeObserver.disconnect();
        ws.close();
        term.dispose();
      };
    }

    const cleanup = init();

    return () => {
      disposed = true;
      cleanup.then((fn) => fn?.());
    };
  }, [cwd, claudeMode]);

  useEffect(() => {
    if (termRef.current && fitAddonRef.current) {
      const term = termRef.current as { options: { theme: unknown } };
      const fitAddon = fitAddonRef.current as { fit: () => void };
      term.options.theme = buildXtermTheme(theme);
      fitAddon.fit();
    }
  }, [theme]);

  useEffect(() => {
    if (isFocused && termRef.current) {
      (termRef.current as { focus: () => void }).focus();
    }
  }, [isFocused]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full min-h-0 min-w-0"
      style={{
        outline: isFocused ? "1px solid var(--primary)" : "none",
        outlineOffset: "-1px",
      }}
      onClick={handleFocus}
    />
  );
}
