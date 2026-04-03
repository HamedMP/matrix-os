"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { getGatewayWs } from "@/lib/gateway";
import type { Theme } from "@/hooks/useTheme";
import { getAnsiPalette } from "./terminal-themes";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { WebLinkProvider } from "./web-link-provider";

function buildXtermTheme(theme: Theme) {
  const bg = theme.colors.background || "#1a1a2e";
  const fg = theme.colors.foreground || "#e0e0e0";
  const slug = (theme as { slug?: string }).slug ?? "";
  const ansi = getAnsiPalette(slug, bg);

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
  const searchAddonRef = useRef<unknown>(null);
  const [searchOpen, setSearchOpen] = useState(false);

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

      // WebGL addon (canvas 2D fallback is automatic if WebGL unavailable)
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webglAddon = new WebglAddon();
        term.loadAddon(webglAddon);

        const canvas = containerRef.current?.querySelector("canvas");
        canvas?.addEventListener("webglcontextlost", () => {
          webglAddon.dispose();
          try {
            const newWebgl = new WebglAddon();
            term.loadAddon(newWebgl);
          } catch (_contextLossErr: unknown) {
            // canvas 2D fallback is automatic
          }
        });
      } catch (_webglErr: unknown) {
        // WebGL not available -- canvas 2D fallback is automatic
      }

      // Search addon
      try {
        const { SearchAddon } = await import("@xterm/addon-search");
        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;
      } catch (_searchErr: unknown) {
        // search addon unavailable
      }

      // Serialize addon
      try {
        const { SerializeAddon } = await import("@xterm/addon-serialize");
        const serializeAddon = new SerializeAddon();
        term.loadAddon(serializeAddon);
      } catch (_serializeErr: unknown) {
        // serialize addon unavailable
      }

      // Link provider for clickable URLs and file paths
      term.registerLinkProvider(new WebLinkProvider());

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

      ws.onclose = () => {
        term.write("\r\n\x1b[90m[Disconnected]\x1b[0m\r\n");
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

      // Keyboard shortcuts: search, copy, paste
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== "keydown") return true;

        // Ctrl+Shift+F: toggle search
        if (ev.ctrlKey && ev.shiftKey && ev.key === "F") {
          setSearchOpen((prev) => !prev);
          return false;
        }

        // Ctrl+Shift+C: copy selection
        if (ev.ctrlKey && ev.shiftKey && ev.key === "C") {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {
              // clipboard API not available
            });
            term.clearSelection();
            return false;
          }
          return true;
        }

        // Ctrl+Shift+V: paste
        if (ev.ctrlKey && ev.shiftKey && ev.key === "V") {
          navigator.clipboard.readText().then((text) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "input", data: text }));
            }
          }).catch(() => {
            // clipboard API not available
          });
          return false;
        }

        return true;
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
      className="h-full w-full min-h-0 min-w-0 relative overflow-hidden"
      style={{
        outline: isFocused ? "1px solid var(--primary)" : "none",
        outlineOffset: "-1px",
      }}
      onClick={handleFocus}
    >
      {searchOpen && searchAddonRef.current && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current as Parameters<typeof TerminalSearchBar>[0]["searchAddon"]}
          isOpen={searchOpen}
          onClose={() => setSearchOpen(false)}
          theme={theme}
        />
      )}
    </div>
  );
}
