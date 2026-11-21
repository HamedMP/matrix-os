"use client";

import { useRef, useState } from "react";

type Action = "discover" | "test";
interface Feedback { error: boolean; message: string }
interface Props {
  disabled: boolean;
  request: (action: Action) => Promise<unknown>;
  onDiscovered: () => Promise<void>;
  onPendingChange: (pending: boolean) => void;
}

function resultMessage(action: Action, result: unknown): string {
  if (!result || typeof result !== "object") throw new Error("Invalid MCP result");
  const body = result as { ok?: unknown; tools?: unknown };
  const count = action === "discover"
    ? (Array.isArray(body.tools) ? body.tools.length : undefined)
    : (body.ok === true && typeof body.tools === "number" ? body.tools : undefined);
  if (count === undefined || !Number.isSafeInteger(count) || count < 0 || count > 100) {
    throw new Error("Invalid MCP tool count");
  }
  if (action === "discover") {
    return count === 0
      ? "Connected, but this server returned no tools. Check the server URL or try Discover again."
      : `Found ${count} ${count === 1 ? "tool" : "tools"}. New tools are enabled by default; review permissions below.`;
  }
  return count === 0
    ? "Connection successful, but the server returned no tools. No tools were executed."
    : `Connection successful. ${count} ${count === 1 ? "tool" : "tools"} available. No tools were executed.`;
}

/** Shared action lifecycle and feedback for every MCP settings renderer. */
export function McpServerDiagnostics({ disabled, request, onDiscovered, onPendingChange }: Props) {
  const running = useRef(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function run(action: Action) {
    if (disabled || running.current) return;
    running.current = true;
    setPending(action);
    setFeedback(null);
    onPendingChange(true);
    try {
      const message = resultMessage(action, await request(action));
      if (action === "discover") await onDiscovered();
      setFeedback({ error: false, message });
    } catch (error: unknown) {
      console.warn("[custom-mcp] diagnostic failed:", error instanceof Error ? error.name : "UnknownError");
      setFeedback({ error: true, message: action === "discover"
        ? "Could not discover tools. Check the server URL and authentication, then retry."
        : "Connection test failed. Check the server URL and authentication, then retry." });
    } finally {
      running.current = false;
      setPending(null);
      onPendingChange(false);
    }
  }

  const button = "inline-flex h-7 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors hover:brightness-95 disabled:opacity-50";
  const buttonStyle = { borderColor: "var(--border-default, var(--border))", color: "var(--text-primary, var(--foreground))", background: "transparent" };
  const muted = { color: "var(--text-tertiary, var(--muted-foreground))" };
  return <div className="mt-3 space-y-2" aria-busy={pending !== null}>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} style={buttonStyle} disabled={disabled || pending !== null} onClick={() => void run("discover")}>
        {pending === "discover" ? "Discovering…" : "Discover"}
      </button>
      <button type="button" className={button} style={buttonStyle} disabled={disabled || pending !== null} onClick={() => void run("test")}>
        {pending === "test" ? "Testing…" : "Test"}
      </button>
      <p className="min-w-0 flex-1 text-xs" style={muted}>Discover loads available tools. Test checks the connection without running a tool.</p>
    </div>
    <p className="text-xs" style={muted}>New tools start on. “Ask every time” needs your approval for each call; “Always allow” runs without asking.</p>
    {pending ? <p role="status" className="text-xs" style={muted}>{pending === "discover" ? "Discovering available tools…" : "Testing connection…"}</p> : null}
    {feedback ? <p role={feedback.error ? "alert" : "status"} className="rounded-lg px-2.5 py-1.5 text-xs"
      style={{ background: feedback.error ? "color-mix(in srgb, var(--danger, var(--destructive, #ba5236)) 10%, transparent)" : "color-mix(in srgb, var(--success, #288a5b) 10%, transparent)", color: "var(--text-primary, var(--foreground))" }}>{feedback.message}</p> : null}
  </div>;
}
