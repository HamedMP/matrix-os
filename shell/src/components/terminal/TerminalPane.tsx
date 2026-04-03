"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { getGatewayWs } from "@/lib/gateway";
import type { Theme } from "@/hooks/useTheme";
import { getAnsiPalette } from "./terminal-themes";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { WebLinkProvider } from "./web-link-provider";
import { cacheTerminal, getCached, removeCached, type CachedTerminal } from "./terminal-cache";

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
  sessionId?: string;
  claudeMode?: boolean;
  onFocus?: (paneId: string) => void;
  onSessionAttached?: (paneId: string, sessionId: string) => void;
  isClosing?: boolean;
}

export function TerminalPane({
  paneId,
  cwd,
  theme,
  isFocused,
  sessionId: initialSessionId,
  claudeMode,
  onFocus,
  onSessionAttached,
  isClosing,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<unknown>(null);
  const fitAddonRef = useRef<unknown>(null);
  const searchAddonRef = useRef<unknown>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const lastSeqRef = useRef<number>(0);
  const reconnectAttemptRef = useRef<number>(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const isClosingRef = useRef(false);

  const handleFocus = useCallback(() => {
    onFocus?.(paneId);
  }, [paneId, onFocus]);

  useEffect(() => {
    isClosingRef.current = !!isClosing;
  }, [isClosing]);

  useEffect(() => {
    let disposed = false;

    async function init() {
      // Check cache first — instant tab switch
      const cached = getCached(paneId);
      if (cached && containerRef.current) {
        // Reattach cached terminal to DOM
        const termElement = (cached.terminal as { element?: HTMLElement }).element;
        if (termElement) {
          containerRef.current.appendChild(termElement);
        }
        cached.fitAddon.fit();
        termRef.current = cached.terminal;
        fitAddonRef.current = cached.fitAddon;
        searchAddonRef.current = cached.searchAddon;
        wsRef.current = cached.ws;
        sessionIdRef.current = cached.sessionId;
        lastSeqRef.current = cached.lastSeq;

        const resizeObserver = new ResizeObserver(() => {
          cached.fitAddon.fit();
        });
        resizeObserver.observe(containerRef.current);

        return () => {
          resizeObserver.disconnect();
        };
      }

      // Cache miss — create fresh terminal
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

      // WebGL addon
      let webglAddon: unknown = null;
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const addon = new WebglAddon();
        term.loadAddon(addon);
        webglAddon = addon;

        const canvas = containerRef.current?.querySelector("canvas");
        canvas?.addEventListener("webglcontextlost", () => {
          (addon as { dispose: () => void }).dispose();
          try {
            const newWebgl = new WebglAddon();
            term.loadAddon(newWebgl);
            webglAddon = newWebgl;
          } catch (_e: unknown) { /* canvas 2D fallback */ }
        });
      } catch (_e: unknown) { /* canvas 2D fallback */ }

      // Search addon
      let searchAddon: unknown = null;
      try {
        const { SearchAddon } = await import("@xterm/addon-search");
        const addon = new SearchAddon();
        term.loadAddon(addon);
        searchAddon = addon;
        searchAddonRef.current = addon;
      } catch (_e: unknown) { /* unavailable */ }

      // Serialize addon
      try {
        const { SerializeAddon } = await import("@xterm/addon-serialize");
        term.loadAddon(new SerializeAddon());
      } catch (_e: unknown) { /* unavailable */ }

      // Link provider
      term.registerLinkProvider(new WebLinkProvider());

      function connectWs() {
        const baseWs = getGatewayWs().replace("/ws", "/ws/terminal");
        const wsUrl = cwd ? `${baseWs}?cwd=${encodeURIComponent(cwd)}` : baseWs;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        let attachSent = false;

        ws.onopen = () => {
          reconnectAttemptRef.current = 0;

          if (sessionIdRef.current) {
            // Reattach to existing session
            ws.send(JSON.stringify({
              type: "attach",
              sessionId: sessionIdRef.current,
              fromSeq: lastSeqRef.current,
            }));
          } else {
            // Create new session
            ws.send(JSON.stringify({ type: "attach", cwd }));
          }
          attachSent = true;

          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));

          if (claudeMode && !sessionIdRef.current) {
            setTimeout(() => {
              ws.send(JSON.stringify({ type: "input", data: "claude\r" }));
            }, 100);
          }
        };

        ws.onerror = () => {
          if (!sessionIdRef.current) {
            term.write("\r\n\x1b[31mConnection error. Is the gateway running?\x1b[0m\r\n");
          }
        };

        ws.onclose = () => {
          if (disposed || isClosingRef.current) return;

          // Attempt reconnection with exponential backoff
          const attempt = reconnectAttemptRef.current;
          if (attempt < 3 && sessionIdRef.current) {
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            reconnectAttemptRef.current = attempt + 1;
            term.write(`\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`);
            setTimeout(() => {
              if (!disposed && !isClosingRef.current) {
                connectWs();
              }
            }, delay);
          } else {
            term.write("\r\n\x1b[90m[Disconnected]\x1b[0m\r\n");
          }
        };

        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");

            switch (msg.type) {
              case "attached":
                sessionIdRef.current = msg.sessionId;
                onSessionAttached?.(paneId, msg.sessionId);
                if (msg.state === "exited") {
                  term.write(`\r\n[Process exited with code ${msg.exitCode ?? "unknown"}]\r\n`);
                }
                break;

              case "output":
                term.write(msg.data);
                if (typeof msg.seq === "number") {
                  lastSeqRef.current = msg.seq + 1;
                }
                break;

              case "replay-start":
                // Replay beginning — output will follow
                break;

              case "replay-end":
                // Replay done, live stream follows
                break;

              case "exit":
                term.write(`\r\n[Process exited with code ${msg.code}]\r\n`);
                break;

              case "error":
                if (msg.message === "Session not found" && sessionIdRef.current) {
                  // Session gone (gateway restarted) — create new session
                  sessionIdRef.current = null;
                  lastSeqRef.current = 0;
                  term.write("\r\n\x1b[33m[Session expired, starting new session...]\x1b[0m\r\n");
                  ws.send(JSON.stringify({ type: "attach", cwd }));
                } else {
                  term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
                }
                break;
            }
          } catch (_e: unknown) {
            // ignore malformed messages
          }
        };
      }

      connectWs();

      term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      // Keyboard shortcuts
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== "keydown") return true;

        if (ev.ctrlKey && ev.shiftKey && ev.key === "F") {
          setSearchOpen((prev) => !prev);
          return false;
        }

        if (ev.ctrlKey && ev.shiftKey && ev.key === "C") {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
            term.clearSelection();
            return false;
          }
          return true;
        }

        if (ev.ctrlKey && ev.shiftKey && ev.key === "V") {
          navigator.clipboard.readText().then((text) => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "input", data: text }));
            }
          }).catch(() => {});
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

        if (isClosingRef.current) {
          // Pane is being closed — clean up everything
          const ws = wsRef.current;
          if (ws) {
            ws.send(JSON.stringify({ type: "detach" }));
            ws.close();
          }
          removeCached(paneId);
          term.dispose();
        } else {
          // Tab switch — cache the terminal for instant restore
          const termElement = (term as { element?: HTMLElement }).element;
          if (termElement?.parentNode) {
            termElement.parentNode.removeChild(termElement);
          }

          cacheTerminal(paneId, {
            terminal: term,
            fitAddon,
            webglAddon,
            searchAddon,
            ws: wsRef.current!,
            lastSeq: lastSeqRef.current,
            sessionId: sessionIdRef.current ?? "",
          });
        }
      };
    }

    const cleanup = init();

    return () => {
      disposed = true;
      cleanup.then((fn) => fn?.());
    };
  }, [cwd, claudeMode, paneId]);

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
