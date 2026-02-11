"use client";

import { useEffect, useRef, useState } from "react";

const TERMINAL_WS =
  process.env.NEXT_PUBLIC_GATEWAY_WS?.replace("/ws", "/ws/terminal") ??
  "ws://localhost:4000/ws/terminal";

export function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;

    async function init() {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");

      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: {
          background: "var(--color-bg, #1a1a2e)",
          foreground: "var(--color-fg, #e0e0e0)",
          cursor: "var(--color-accent, #64ffda)",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();

      termRef.current = term;

      const ws = new WebSocket(TERMINAL_WS);
      wsRef.current = ws;

      ws.onopen = () => {
        setReady(true);
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          }),
        );
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "output") {
            term.write(msg.data);
          } else if (msg.type === "exit") {
            term.write("\r\n[Process exited]\r\n");
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onclose = () => {
        setReady(false);
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
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b text-xs select-none"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <span className="font-medium">Terminal</span>
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{
            background: ready
              ? "var(--color-success)"
              : "var(--color-error)",
          }}
        />
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ background: "var(--color-bg)" }}
      />
    </div>
  );
}
