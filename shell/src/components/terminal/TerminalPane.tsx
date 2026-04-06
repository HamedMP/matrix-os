"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { getGatewayWs } from "@/lib/gateway";
import type { Theme } from "@/hooks/useTheme";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { getAnsiPalette } from "./terminal-themes";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { WebLinkProvider } from "./web-link-provider";
import { cacheTerminal, getCached, removeCached, type CachedTerminal } from "./terminal-cache";
import { createSocketHealth } from "@/lib/socket-health";

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

const BRACKETED_PASTE_OPEN = "\x1b[200~";
const BRACKETED_PASTE_CLOSE = "\x1b[201~";
const BRACKETED_PASTE_OVERHEAD = BRACKETED_PASTE_OPEN.length + BRACKETED_PASTE_CLOSE.length;
const MAX_TERMINAL_INPUT = 65_536;

type TerminalServerMessage =
  | { type: "attached"; sessionId: string; state: "running" | "exited"; exitCode: number | null }
  | { type: "output"; data: string; seq: number | null }
  | { type: "replay-start" }
  | { type: "replay-end" }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stripTerminalControls(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function parseTerminalServerMessage(raw: string): TerminalServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "attached":
      if (typeof msg.sessionId !== "string" || (msg.state !== "running" && msg.state !== "exited")) {
        return null;
      }
      return {
        type: "attached",
        sessionId: msg.sessionId,
        state: msg.state,
        exitCode: toFiniteNumber(msg.exitCode),
      };
    case "output":
      if (typeof msg.data !== "string") {
        return null;
      }
      return {
        type: "output",
        data: msg.data,
        seq: Number.isInteger(msg.seq) && (msg.seq as number) >= 0 ? (msg.seq as number) : null,
      };
    case "replay-start":
      return { type: "replay-start" };
    case "replay-end":
      return { type: "replay-end" };
    case "exit":
      return { type: "exit", code: toFiniteNumber(msg.code) };
    case "error":
      return {
        type: "error",
        message: typeof msg.message === "string" ? msg.message : "Unknown error",
      };
    default:
      return null;
  }
}

function extractTrustedClaudeAuthUrl(raw: string): string | null {
  const stripped = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x20\x7f-\x9f]/g, "");
  const match = stripped.match(/https:\/\/claude\.ai\/oauth\/authorize[^"'<>)]{0,2048}?state=[A-Za-z0-9_-]+/);
  if (!match) {
    return null;
  }

  try {
    const url = new URL(match[0]);
    const state = url.searchParams.get("state");
    const responseType = url.searchParams.get("response_type");
    const clientId = url.searchParams.get("client_id");
    if (
      url.origin !== "https://claude.ai" ||
      url.pathname !== "/oauth/authorize" ||
      responseType !== "code" ||
      !clientId ||
      !state ||
      !/^[A-Za-z0-9_-]+$/.test(state) ||
      url.searchParams.has("redirect")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
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
  shouldCacheOnUnmount?: (paneId: string) => boolean;
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
  shouldCacheOnUnmount,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<unknown>(null);
  const fitAddonRef = useRef<unknown>(null);
  const searchAddonRef = useRef<unknown>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const lastSeqRef = useRef<number>(0);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSessionAttachedRef = useRef(onSessionAttached);
  const shouldCacheOnUnmountRef = useRef(shouldCacheOnUnmount);
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglContextLostHandlerRef = useRef<((event: Event) => void) | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const outputBufferRef = useRef("");
  const authDetectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isClosingRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof createSocketHealth> | null>(null);

  onSessionAttachedRef.current = onSessionAttached;
  shouldCacheOnUnmountRef.current = shouldCacheOnUnmount;

  const handleFocus = useCallback(() => {
    onFocus?.(paneId);
  }, [paneId, onFocus]);

  useEffect(() => {
    isClosingRef.current = !!isClosing;
  }, [isClosing]);

  useEffect(() => {
    if (initialSessionId) {
      sessionIdRef.current = initialSessionId;
    }
  }, [initialSessionId]);

  useEffect(() => {
    let disposed = false;

    async function init() {
      const clearAuthDetectTimer = () => {
        if (authDetectTimerRef.current) {
          clearTimeout(authDetectTimerRef.current);
          authDetectTimerRef.current = null;
        }
      };

      const clearReconnectTimer = () => {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      };

      const detachWebglContextLostHandler = () => {
        if (webglCanvasRef.current && webglContextLostHandlerRef.current) {
          webglCanvasRef.current.removeEventListener("webglcontextlost", webglContextLostHandlerRef.current);
        }
        webglCanvasRef.current = null;
        webglContextLostHandlerRef.current = null;
      };

      const container = containerRef.current;
      if (!container) {
        return;
      }

      // Check cache first — instant tab switch
      const cached = getCached(paneId);
      const canReuseCached = Boolean(
        cached &&
        (cached.ws.readyState === WebSocket.OPEN || cached.ws.readyState === WebSocket.CONNECTING),
      );

      let term: Terminal;
      let fitAddon: FitAddon;
      let searchAddon: unknown = null;
      let webglAddon: unknown = null;

      const attachWebglContextLostHandler = () => {
        detachWebglContextLostHandler();
        const canvas = container.querySelector("canvas");
        if (!(canvas instanceof HTMLCanvasElement)) {
          return;
        }

        const onWebglContextLost = async () => {
          if (disposed) {
            return;
          }

          try {
            (webglAddon as { dispose?: () => void } | null)?.dispose?.();
          } catch (_err: unknown) {
            // Ignore disposal errors and fall back to 2D rendering.
          }

          try {
            const { WebglAddon } = await import("@xterm/addon-webgl");
            if (disposed) {
              return;
            }
            const nextWebglAddon = new WebglAddon();
            term.loadAddon(nextWebglAddon);
            webglAddon = nextWebglAddon;
          } catch (_err: unknown) {
            // Canvas 2D fallback is acceptable if WebGL re-init fails.
          }
        };

        webglCanvasRef.current = canvas;
        webglContextLostHandlerRef.current = onWebglContextLost;
        canvas.addEventListener("webglcontextlost", onWebglContextLost);
      };

      if (canReuseCached && cached) {
        const termElement = (cached.terminal as { element?: HTMLElement }).element;
        if (termElement) {
          container.appendChild(termElement);
        }
        term = cached.terminal;
        fitAddon = cached.fitAddon;
        searchAddon = cached.searchAddon;
        webglAddon = cached.webglAddon;
        fitAddon.fit();
        termRef.current = cached.terminal;
        fitAddonRef.current = cached.fitAddon;
        searchAddonRef.current = cached.searchAddon;
        wsRef.current = cached.ws;
        sessionIdRef.current = cached.sessionId;
        lastSeqRef.current = cached.lastSeq;
      } else {
        if (cached) {
          removeCached(paneId);
          try {
            cached.terminal.dispose();
          } catch (err: unknown) {
            console.warn("Failed to dispose stale terminal cache:", err instanceof Error ? err.message : err);
          }
        }

        // Cache miss — create fresh terminal
        const { Terminal: XTerm } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");

        if (disposed) return;

        const xtermTheme = buildXtermTheme(theme);

        const xterm = new XTerm({
          cursorBlink: true,
          allowProposedApi: true,
          fontSize: 13,
          fontFamily: theme.fonts?.mono || "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
          theme: xtermTheme,
        });

        const nextFitAddon = new FitAddon();
        xterm.loadAddon(nextFitAddon);
        xterm.open(container);
        nextFitAddon.fit();

        term = xterm;
        fitAddon = nextFitAddon;
        termRef.current = xterm;
        fitAddonRef.current = nextFitAddon;

        // WebGL addon
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          const addon = new WebglAddon();
          xterm.loadAddon(addon);
          webglAddon = addon;
        } catch (_e: unknown) { /* canvas 2D fallback */ }

        // Search addon
        try {
          const { SearchAddon } = await import("@xterm/addon-search");
          const addon = new SearchAddon();
          xterm.loadAddon(addon);
          searchAddon = addon;
          searchAddonRef.current = addon;
        } catch (_e: unknown) { /* unavailable */ }

        // Serialize addon
        try {
          const { SerializeAddon } = await import("@xterm/addon-serialize");
          xterm.loadAddon(new SerializeAddon());
        } catch (_e: unknown) { /* unavailable */ }

        // Link provider
        xterm.registerLinkProvider(new WebLinkProvider(xterm));

        if (disposed) {
          xterm.dispose();
          return;
        }
      }

      attachWebglContextLostHandler();

      function bindWs(ws: WebSocket, attachOnOpen: boolean) {
        wsRef.current = ws;

        const sendAttach = () => {
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
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "input", data: "claude\r" }));
              }
            }, 100);
          }
        };

        ws.onopen = () => {
          reconnectAttemptRef.current = 0;
          clearReconnectTimer();

          // Start heartbeat
          if (heartbeatRef.current) heartbeatRef.current.stop();
          heartbeatRef.current = createSocketHealth({
            pingIntervalMs: 30_000,
            pongTimeoutMs: 5_000,
            send: (data) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(data);
            },
            onDead: () => {
              ws.close(); // triggers onclose -> reconnect
            },
          });
          heartbeatRef.current.start();

          if (attachOnOpen) {
            sendAttach();
          }
        };

        ws.onerror = () => {
          if (!sessionIdRef.current) {
            term.write("\r\n\x1b[31mConnection error. Is the gateway running?\x1b[0m\r\n");
          }
        };

        ws.onclose = () => {
          heartbeatRef.current?.stop();
          if (disposed || isClosingRef.current) return;

          // Attempt reconnection with exponential backoff
          const attempt = reconnectAttemptRef.current;
          if (attempt < 3 && sessionIdRef.current) {
            clearReconnectTimer();
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            reconnectAttemptRef.current = attempt + 1;
            term.write(`\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`);
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              if (!disposed && !isClosingRef.current) {
                connectWs();
              }
            }, delay);
          } else {
            term.write("\r\n\x1b[90m[Disconnected]\x1b[0m\r\n");
          }
        };

        ws.onmessage = (evt) => {
          const raw = typeof evt.data === "string" ? evt.data : "";
          // Fast pong handling (skip full parse)
          if (raw.includes('"pong"')) {
            try {
              const quick = JSON.parse(raw) as { type: string };
              if (quick.type === "pong") {
                heartbeatRef.current?.receivedPong();
                return;
              }
            } catch { /* fall through to normal parse */ }
          }

          const msg = parseTerminalServerMessage(raw);
          if (!msg) {
            return;
          }

          switch (msg.type) {
            case "attached":
              sessionIdRef.current = msg.sessionId;
              onSessionAttachedRef.current?.(paneId, msg.sessionId);
              if (msg.state === "exited") {
                const exitCode = msg.exitCode ?? "unknown";
                term.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
              }
              break;

            case "output":
              term.write(msg.data);
              if (msg.seq !== null) {
                lastSeqRef.current = msg.seq + 1;
              }
              outputBufferRef.current += msg.data;
              if (outputBufferRef.current.length > 8192) {
                outputBufferRef.current = outputBufferRef.current.slice(-4096);
              }
              if (outputBufferRef.current.includes("claude.ai/oauth/authorize")) {
                clearAuthDetectTimer();
                authDetectTimerRef.current = setTimeout(() => {
                  authDetectTimerRef.current = null;
                  if (disposed) {
                    outputBufferRef.current = "";
                    return;
                  }
                  const nextAuthUrl = extractTrustedClaudeAuthUrl(outputBufferRef.current);
                  if (nextAuthUrl) {
                    setAuthUrl(nextAuthUrl);
                  }
                  outputBufferRef.current = "";
                }, 300);
              }
              break;

            case "replay-start":
              clearAuthDetectTimer();
              outputBufferRef.current = "";
              break;
            case "replay-end":
              break;

            case "exit": {
              const code = msg.code ?? "unknown";
              term.write(`\r\n[Process exited with code ${code}]\r\n`);
              break;
            }

            case "error": {
              const safeMsg = stripTerminalControls(msg.message);
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

        if (!attachOnOpen && ws.readyState === WebSocket.OPEN && sessionIdRef.current) {
          sendAttach();
        }
      }

      function connectWs() {
        const baseWs = getGatewayWs().replace("/ws", "/ws/terminal");
        const wsUrl = cwd ? `${baseWs}?cwd=${encodeURIComponent(cwd)}` : baseWs;
        const ws = new WebSocket(wsUrl);
        bindWs(ws, true);
      }

      if (canReuseCached && cached) {
        bindWs(cached.ws, cached.ws.readyState === WebSocket.CONNECTING);
      } else {
        connectWs();
      }

      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            heartbeatRef.current?.pingNow();
          } else if (!disposed && !isClosingRef.current && sessionIdRef.current) {
            // Disconnected while hidden, reconnect now
            reconnectAttemptRef.current = 0;
            clearReconnectTimer();
            connectWs();
          }
        }
      };

      document.addEventListener("visibilitychange", onVisibilityChange);

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
              const safe = text.replace(/\x1b\[20[01]~/g, "");
              const capped = safe.slice(0, MAX_TERMINAL_INPUT - BRACKETED_PASTE_OVERHEAD);
              const bracketed = `${BRACKETED_PASTE_OPEN}${capped}${BRACKETED_PASTE_CLOSE}`;
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
      resizeObserver.observe(container);

      return () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        resizeObserver.disconnect();
        clearAuthDetectTimer();
        clearReconnectTimer();
        heartbeatRef.current?.stop();
        detachWebglContextLostHandler();
        const shouldCache = !isClosingRef.current && (shouldCacheOnUnmountRef.current?.(paneId) ?? true);

        if (!shouldCache) {
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
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>Claude Code login required</div>
            <div style={{ fontSize: 11, opacity: 0.85 }}>
              Detected from terminal output. Terminal apps can spoof this. Only continue if you initiated Claude Code login.
            </div>
            <div
              style={{
                fontSize: 11,
                opacity: 0.9,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={authUrl}
            >
              {authUrl}
            </div>
          </div>
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
              navigator.clipboard.writeText(authUrl).catch(() => {
                // Fallback for insecure contexts / iframe restrictions
                const ta = document.createElement("textarea");
                ta.value = authUrl;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
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
