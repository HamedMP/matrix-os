"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { getGatewayUrl, getGatewayWs } from "@/lib/gateway";
import { createSocketHealth } from "@/lib/socket-health";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { useTerminalSettings } from "@/stores/terminal-settings";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";
import type { Theme } from "@/hooks/useTheme";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { getAnsiPalette, getTerminalThemePreset } from "./terminal-themes";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { WebLinkProvider } from "./web-link-provider";
import { cacheTerminal, getCached, removeCached, type CachedTerminal } from "./terminal-cache";
import { closeStaleCachedSocket, getCachedTerminalRestorePlan } from "./terminal-restore";

function buildXtermTheme(theme: Theme, terminalThemeId: import("@/stores/terminal-settings").TerminalThemeId) {
  if (terminalThemeId !== "system") {
    return getTerminalThemePreset(terminalThemeId);
  }

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
const MAX_OSC52_BASE64_LENGTH = 1_000_000;
const OSC52_ALLOWED_TARGETS = new Set(["", "c", "p", "s", "0", "1", "2", "3", "4", "5", "6", "7"]);

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
  } catch (_err: unknown) {
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
  } catch (_err: unknown) {
    return null;
  }
}

function terminalDebug(event: string, details: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  console.info("[terminal-debug][pane]", event, details);
}

function describeReadyState(ws: WebSocket | null): string {
  if (!ws) {
    return "null";
  }

  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return `UNKNOWN(${String((ws as { readyState?: unknown }).readyState)})`;
  }
}

interface TerminalPaneProps {
  paneId: string;
  cwd: string;
  theme: Theme;
  isFocused: boolean;
  sessionId?: string;
  claudeMode?: boolean;
  startupCommand?: string;
  onFocus?: (paneId: string) => void;
  onSessionAttached?: (paneId: string, sessionId: string) => void;
  isClosing?: boolean;
  shouldCacheOnUnmount?: (paneId: string) => boolean;
  shouldDestroyOnUnmount?: (paneId: string) => boolean;
}

export function TerminalPane({
  paneId,
  cwd,
  theme,
  isFocused,
  sessionId: initialSessionId,
  claudeMode,
  startupCommand,
  onFocus,
  onSessionAttached,
  isClosing,
  shouldCacheOnUnmount,
  shouldDestroyOnUnmount,
}: TerminalPaneProps) {
  const terminalThemeId = useTerminalSettings((s) => s.themeId);
  const terminalFontSize = useTerminalSettings((s) => s.fontSize);
  const cursorBlink = useTerminalSettings((s) => s.cursorBlink);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<unknown>(null);
  const fitAddonRef = useRef<unknown>(null);
  const searchAddonRef = useRef<unknown>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const lastSeqRef = useRef<number>(0);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectLinesWrittenRef = useRef<number>(0);
  const onSessionAttachedRef = useRef(onSessionAttached);
  const shouldCacheOnUnmountRef = useRef(shouldCacheOnUnmount);
  const shouldDestroyOnUnmountRef = useRef(shouldDestroyOnUnmount);
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webglContextLostHandlerRef = useRef<((event: Event) => void) | null>(null);
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const onResizeDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const outputBufferRef = useRef("");
  const authDetectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isClosingRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof createSocketHealth> | null>(null);

  onSessionAttachedRef.current = onSessionAttached;
  shouldCacheOnUnmountRef.current = shouldCacheOnUnmount;
  shouldDestroyOnUnmountRef.current = shouldDestroyOnUnmount;

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
      const log = (event: string, details: Record<string, unknown> = {}) => {
        terminalDebug(event, {
          paneId,
          cwd,
          sessionId: sessionIdRef.current,
          lastSeq: lastSeqRef.current,
          wsState: describeReadyState(wsRef.current),
          ...details,
        });
      };

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
      const cachedRestore = getCachedTerminalRestorePlan(getCached(paneId));
      const cached = cachedRestore.cached;
      const canReuseCachedTerminal = cachedRestore.reuseTerminal;
      const canReuseCachedSocket = cachedRestore.reuseSocket;
      log("init", {
        cached: !!cached,
        reuseTerminal: canReuseCachedTerminal,
        reuseSocket: canReuseCachedSocket,
        cachedSessionId: cachedRestore.sessionId,
        cachedLastSeq: cachedRestore.lastSeq,
      });

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

      if (canReuseCachedTerminal && cached) {
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
        sessionIdRef.current = cachedRestore.sessionId;
        lastSeqRef.current = cachedRestore.lastSeq;
      } else {
        // Cache miss — create fresh terminal
        const { Terminal: XTerm } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");

        if (disposed) return;

        const xtermTheme = buildXtermTheme(theme, terminalThemeId);

        const xterm = new XTerm({
          cursorBlink,
          allowProposedApi: true,
          fontSize: terminalFontSize,
          fontFamily: theme.fonts?.mono || "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
          theme: xtermTheme,
          // Make ⌥ (Option) on macOS act as Meta — without this, Option+Left/Right
          // never reaches the shell as ESC-b / ESC-f, so word-jump is broken.
          macOptionIsMeta: true,
          // Send a Unicode bullet for Option+key combos that fall through to the
          // browser instead of producing accented characters.
          macOptionClickForcesSelection: true,
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

        // OSC 52 clipboard handler — used by TUIs (Claude Code, tmux, neovim, ...)
        // to copy text to the host clipboard. Format: "<Pc>;<Pd>" where Pc is the
        // selection target ("c", "p", "s", "0"-"7") and Pd is base64 or "?".
        try {
          xterm.parser.registerOscHandler(52, (data: string) => {
            const semi = data.indexOf(";");
            if (semi < 0) return false;
            const target = data.slice(0, semi);
            if (!OSC52_ALLOWED_TARGETS.has(target)) return false;
            const payload = data.slice(semi + 1);
            if (payload === "" || payload === "?") {
              // Query for current clipboard contents — we don't expose this.
              return true;
            }
            if (payload.length > MAX_OSC52_BASE64_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(payload)) {
              return false;
            }
            let text: string;
            try {
              const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
              text = new TextDecoder().decode(bytes);
            } catch (_err: unknown) {
              return false;
            }
            const fallbackCopy = () => {
              try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                ta.setAttribute("data-osc52-fallback", "true");
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
              } catch (err: unknown) {
                console.warn("OSC 52 fallback copy failed:", err instanceof Error ? err.message : err);
              } finally {
                document.querySelectorAll("textarea[data-osc52-fallback='true']").forEach((node) => node.remove());
              }
            };
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(text).catch((err: unknown) => {
                console.warn("OSC 52 clipboard write failed, using fallback:", err instanceof Error ? err.message : err);
                fallbackCopy();
              });
            } else {
              fallbackCopy();
            }
            return true;
          });
        } catch (err: unknown) {
          console.warn("Failed to register OSC 52 handler:", err instanceof Error ? err.message : err);
        }

        if (disposed) {
          xterm.dispose();
          return;
        }
      }

      attachWebglContextLostHandler();

      function bindWs(ws: WebSocket, attachOnOpen: boolean) {
        wsRef.current = ws;
        log("bind-ws", {
          attachOnOpen,
          boundWsState: describeReadyState(ws),
        });

        const sendAttach = () => {
          const attachMode = sessionIdRef.current ? "reattach" : "create";
          log("send-attach", {
            attachMode,
            attachSessionId: sessionIdRef.current,
            fromSeq: lastSeqRef.current,
          });
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

          const startup = sessionIdRef.current
            ? null
            : startupCommand?.trim() || (claudeMode ? "claude" : null);
          if (startup) {
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "input", data: `${startup}\r` }));
              }
            }, 100);
          }
        };

        ws.onopen = () => {
          reconnectAttemptRef.current = 0;
          clearReconnectTimer();
          if (reconnectLinesWrittenRef.current > 0) {
            // Erase the "[Reconnecting in Ns...]" lines we appended while
            // disconnected so the scrollback stays clean after recovery.
            // Each banner is `\r\n[text]\r\n` -- the leading \r\n moves onto
            // a fresh line, so we only need to move up (lines - 1) to land
            // on the first banner row without clobbering the content row
            // that was there before the disconnect.
            const lines = reconnectLinesWrittenRef.current;
            term.write(`\x1b[${lines - 1}A\r\x1b[0J`);
            reconnectLinesWrittenRef.current = 0;
          }
          log("ws-open", { attachOnOpen });

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
          log("ws-error");
          if (!sessionIdRef.current) {
            term.write("\r\n\x1b[31mConnection error. Is the gateway running?\x1b[0m\r\n");
          }
        };

        ws.onclose = () => {
          heartbeatRef.current?.stop();
          log("ws-close", {
            disposed,
            isClosing: isClosingRef.current,
            reconnectAttempt: reconnectAttemptRef.current,
          });
          if (disposed || isClosingRef.current) return;

          // Attempt reconnection with exponential backoff
          const attempt = reconnectAttemptRef.current;
          if (attempt < 3 && sessionIdRef.current) {
            clearReconnectTimer();
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            reconnectAttemptRef.current = attempt + 1;
            log("schedule-reconnect", { delayMs: delay, nextAttempt: reconnectAttemptRef.current });
            term.write(`\r\n\x1b[33m[Reconnecting in ${delay / 1000}s...]\x1b[0m\r\n`);
            reconnectLinesWrittenRef.current += 2;
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              if (!disposed && !isClosingRef.current) {
                log("run-reconnect");
                connectWs();
              }
            }, delay);
          } else {
            term.write("\r\n\x1b[90m[Disconnected]\x1b[0m\r\n");
            // Give up cleaning the "[Reconnecting...]" banners - leave them
            // as context for why we disconnected.
            reconnectLinesWrittenRef.current = 0;
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
            } catch (_err: unknown) { /* fall through to normal parse */ }
          }

          const msg = parseTerminalServerMessage(raw);
          if (!msg) {
            return;
          }

          switch (msg.type) {
            case "attached":
              log("attached", {
                attachedSessionId: msg.sessionId,
                state: msg.state,
                exitCode: msg.exitCode ?? null,
              });
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
              log("server-error", { message: safeMsg });
              if (safeMsg === "Session not found" && sessionIdRef.current) {
                log("session-not-found-reset");
                sessionIdRef.current = null;
                lastSeqRef.current = 0;
                term.write("\r\n\x1b[33m[Session expired, starting new session...]\x1b[0m\r\n");
                log("fallback-create-after-session-not-found");
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
        const query =
          sessionIdRef.current || !cwd
            ? undefined
            : { cwd };
        log("connect-ws", {
          queryCwd: query?.cwd ?? null,
          reconnectAttempt: reconnectAttemptRef.current,
        });

        void buildAuthenticatedWebSocketUrl("/ws/terminal", {
          cwd: query?.cwd,
        })
          .catch((err: unknown) => {
            console.warn(
              "[terminal] Falling back to unauthenticated terminal websocket URL:",
              err instanceof Error ? err.message : err,
            );
            const baseWs = getGatewayWs().replace("/ws", "/ws/terminal");
            return query?.cwd ? `${baseWs}?cwd=${encodeURIComponent(query.cwd)}` : baseWs;
          })
          .then((wsUrl) => {
            if (disposed || isClosingRef.current) {
              log("connect-ws-abort", { reason: disposed ? "disposed" : "closing" });
              return;
            }
            log("connect-ws-url", {
              urlIncludesCwd: wsUrl.includes("cwd="),
              urlIncludesToken: wsUrl.includes("token="),
            });
            const ws = new WebSocket(wsUrl);
            bindWs(ws, true);
          });
      }

      if (cached && canReuseCachedSocket) {
        bindWs(cached.ws, cached.ws.readyState === WebSocket.CONNECTING);
      } else {
        closeStaleCachedSocket(cached);
        connectWs();
      }

      const onVisibilityChange = () => {
        log("visibilitychange", { visibilityState: document.visibilityState });
        if (document.visibilityState === "visible") {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            log("visibility-ping-now");
            heartbeatRef.current?.pingNow();
          } else if (!disposed && !isClosingRef.current && sessionIdRef.current) {
            // Disconnected while hidden, reconnect now
            reconnectAttemptRef.current = 0;
            clearReconnectTimer();
            log("visibility-reconnect-now");
            connectWs();
          }
        }
      };

      document.addEventListener("visibilitychange", onVisibilityChange);

      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      onResizeDisposableRef.current?.dispose();
      onResizeDisposableRef.current = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      // Keyboard shortcuts
      const sendRaw = (data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      };

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

        // macOS-style line-editing shortcuts. The browser only delivers
        // Cmd-arrow events to us when the focus is inside xterm; otherwise
        // the OS swallows them. We map them to the readline-equivalent
        // control sequences so bash/zsh, claude, pi, etc. all behave
        // predictably regardless of OS keymap.
        if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          if (ev.key === "ArrowLeft") {
            sendRaw("\x01"); // Ctrl-A — beginning of line
            return false;
          }
          if (ev.key === "ArrowRight") {
            sendRaw("\x05"); // Ctrl-E — end of line
            return false;
          }
          if (ev.key === "Backspace") {
            sendRaw("\x15"); // Ctrl-U — kill to start of line
            return false;
          }
          if (ev.key === "ArrowUp") {
            sendRaw("\x1b[1;5H"); // scroll-to-top emulation: Home with Ctrl mod
            return false;
          }
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
        onDataDisposableRef.current?.dispose();
        onDataDisposableRef.current = null;
        onResizeDisposableRef.current?.dispose();
        onResizeDisposableRef.current = null;
        const shouldCache = !isClosingRef.current && (shouldCacheOnUnmountRef.current?.(paneId) ?? true);
        const shouldDestroy = shouldDestroyOnUnmountRef.current?.(paneId) ?? false;
        log("cleanup", {
          shouldCache,
          shouldDestroy,
          isClosing: isClosingRef.current,
          paneStillInTree: shouldCacheOnUnmountRef.current?.(paneId) ?? true,
        });

        if (!shouldCache) {
          // Plain unmounts should not destroy the session. Explicit pane/tab close
          // may still need to destroy a just-created session before layout state
          // has been updated with its session id.
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            if (shouldDestroy) {
              log("cleanup-destroy-via-ws");
              ws.send(JSON.stringify({ type: "destroy" }));
            } else {
              log("cleanup-detach-via-ws");
              ws.send(JSON.stringify({ type: "detach" }));
            }
          }
          ws?.close();
          removeCached(paneId);
          term.dispose();
        } else if (wsRef.current) {
          // Tab switch — cache the terminal for instant restore
          log("cleanup-cache-terminal");
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
          log("cleanup-dispose-no-ws");
          term.dispose();
        }
      };
    }

    const cleanup = init();

    return () => {
      disposed = true;
      cleanup.then((fn) => fn?.());
    };
  }, [claudeMode, cursorBlink, cwd, paneId, startupCommand, terminalFontSize, terminalThemeId, theme]);

  useEffect(() => {
    if (termRef.current && fitAddonRef.current) {
      const term = termRef.current as { options: { theme: unknown; fontFamily: string; fontSize: number; cursorBlink: boolean } };
      const fitAddon = fitAddonRef.current as { fit: () => void };
      term.options.theme = buildXtermTheme(theme, terminalThemeId);
      term.options.fontFamily = theme.fonts?.mono || "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace";
      term.options.fontSize = terminalFontSize;
      term.options.cursorBlink = cursorBlink;
      fitAddon.fit();
    }
  }, [cursorBlink, terminalFontSize, terminalThemeId, theme]);

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
              navigator.clipboard.writeText(authUrl).catch((_err: unknown) => {
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
