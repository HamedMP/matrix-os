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
  const onSessionAttachedRef = useRef(onSessionAttached);
  const [searchOpen, setSearchOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const outputBufferRef = useRef("");
  const authDetectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isClosingRef = useRef(false);

  onSessionAttachedRef.current = onSessionAttached;

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
        if (cached.ws.readyState === WebSocket.OPEN || cached.ws.readyState === WebSocket.CONNECTING) {
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
            if (isClosingRef.current) {
              const ws = wsRef.current;
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "detach" }));
              }
              ws?.close();
              removeCached(paneId);
              cached.terminal.dispose();
            } else {
              cached.lastSeq = lastSeqRef.current;
            }
          };
        }
        // WS closed — discard stale cache, create fresh terminal below
        removeCached(paneId);
        try { cached.terminal.dispose(); } catch { /* already disposed */ }
      }

      // Cache miss — create fresh terminal
      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      if (disposed || !containerRef.current) return;

      const xtermTheme = buildXtermTheme(theme);

      const term = new XTerm({
        cursorBlink: true,
        allowProposedApi: true,
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
      term.registerLinkProvider(new WebLinkProvider(term));

      function connectWs() {
        const baseWs = getGatewayWs().replace("/ws", "/ws/terminal");
        const wsUrl = cwd ? `${baseWs}?cwd=${encodeURIComponent(cwd)}` : baseWs;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttemptRef.current = 0;

          if (sessionIdRef.current) {
            ws.send(JSON.stringify({
              type: "attach",
              sessionId: sessionIdRef.current,
              fromSeq: lastSeqRef.current,
            }));
          } else {
            ws.send(JSON.stringify({ type: "attach", cwd }));
          }

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
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
          } catch {
            return;
          }

          switch (msg.type) {
            case "attached":
              sessionIdRef.current = msg.sessionId as string;
              onSessionAttachedRef.current?.(paneId, msg.sessionId as string);
              if (msg.state === "exited") {
                term.write(`\r\n[Process exited with code ${msg.exitCode ?? "unknown"}]\r\n`);
              }
              break;

            case "output": {
              const outputData = msg.data as string;
              term.write(outputData);
              if (typeof msg.seq === "number") {
                lastSeqRef.current = (msg.seq as number) + 1;
              }
              // Detect auth URLs in streaming output (debounced -- URL arrives in chunks)
              outputBufferRef.current += outputData;
              if (outputBufferRef.current.length > 8192) {
                outputBufferRef.current = outputBufferRef.current.slice(-4096);
              }
              if (outputBufferRef.current.includes("claude.ai/oauth/authorize")) {
                if (authDetectTimerRef.current) clearTimeout(authDetectTimerRef.current);
                authDetectTimerRef.current = setTimeout(() => {
                  // Strip ANSI escape sequences and line breaks, keep spaces as delimiters
                  const stripped = outputBufferRef.current
                    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
                    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
                    .replace(/[\r\n]/g, "")
                    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
                  const match = stripped.match(/https:\/\/claude\.ai\/oauth\/authorize[^\s]+/);
                  if (match) {
                    setAuthUrl(match[0]);
                  }
                  outputBufferRef.current = "";
                }, 300);
              }
              break;
            }

            case "replay-start":
              break;

            case "replay-end":
              break;

            case "exit":
              term.write(`\r\n[Process exited with code ${msg.code}]\r\n`);
              break;

            case "error": {
              const safeMsg = String(msg.message ?? "Unknown error").replace(/[\x00-\x1f]/g, "");
              if (safeMsg === "Session not found" && sessionIdRef.current) {
                sessionIdRef.current = null;
                lastSeqRef.current = 0;
                term.write("\r\n\x1b[33m[Session expired, starting new session...]\x1b[0m\r\n");
                ws.send(JSON.stringify({ type: "attach", cwd }));
              } else {
                term.write(`\r\n\x1b[31m[Error: ${safeMsg}]\x1b[0m\r\n`);
              }
              break;
            }
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
            navigator.clipboard.writeText(selection).catch((err: unknown) => {
              console.warn("Clipboard copy failed:", err instanceof Error ? err.message : err);
            });
            term.clearSelection();
            return false;
          }
          return true;
        }

        if (ev.ctrlKey && ev.shiftKey && ev.key === "V") {
          navigator.clipboard.readText().then((text) => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              const capped = text.slice(0, 65536);
              const bracketed = `\x1b[200~${capped}\x1b[201~`;
              ws.send(JSON.stringify({ type: "input", data: bracketed }));
            }
          }).catch((err: unknown) => {
            console.warn("Clipboard paste failed:", err instanceof Error ? err.message : err);
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

        if (isClosingRef.current) {
          // Pane is being closed — clean up everything
          const ws = wsRef.current;
          if (ws) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "detach" }));
            }
            ws.close();
          }
          removeCached(paneId);
          term.dispose();
        } else if (wsRef.current) {
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
            ws: wsRef.current,
            lastSeq: lastSeqRef.current,
            sessionId: sessionIdRef.current ?? "",
          });
        } else {
          // WS never established — dispose, don't cache
          term.dispose();
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
      {authUrl && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            right: 8,
            zIndex: 20,
            background: theme.colors.primary || "#c2703a",
            color: "#fff",
            borderRadius: 8,
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          <span style={{ flex: 1 }}>Claude Code login required</span>
          <button
            onClick={() => {
              window.open(authUrl, "_blank", "noopener,noreferrer");
            }}
            style={{
              background: "rgba(255,255,255,0.2)",
              border: "1px solid rgba(255,255,255,0.3)",
              color: "#fff",
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 13,
              whiteSpace: "nowrap",
            }}
          >
            Open login
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(authUrl).catch((err: unknown) => {
                console.warn("Clipboard copy failed:", err instanceof Error ? err.message : err);
              });
            }}
            style={{
              background: "rgba(255,255,255,0.2)",
              border: "1px solid rgba(255,255,255,0.3)",
              color: "#fff",
              borderRadius: 6,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 13,
              whiteSpace: "nowrap",
            }}
          >
            Copy URL
          </button>
          <button
            onClick={() => setAuthUrl(null)}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.7)",
              cursor: "pointer",
              fontSize: 16,
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
      )}
      {searchOpen && !!searchAddonRef.current && (
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
