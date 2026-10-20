"use client";
import { useEffect, useRef, useState } from "react";
import { SHARED_WORKSPACE_PREFIX } from "@/lib/shared-workspace";

type TaskRequest = { type: "chat"; chatId: string; message: string; idempotencyKey: string };

/** Explicit spike action; regular Chat/Terminal remain on their real transport. */
export function SharedBackgroundTask() {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "accepted" | "failed">("idle");
  const pending = useRef<TaskRequest | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit() {
    const message = draft.trim();
    if (!message || message.length > 2000 || status === "sending") return;
    // An ambiguous failure retries the same operation instead of starting a
    // second agent. Editing the prompt deliberately creates a different task.
    const task = pending.current ?? {
      type: "chat" as const, chatId: `chat_${crypto.randomUUID().replaceAll("-", "")}`,
      idempotencyKey: crypto.randomUUID(), message,
    };
    pending.current = task;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setStatus("sending");
    try {
      const response = await fetch(`${SHARED_WORKSPACE_PREFIX}/api/workspace/actions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(task),
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]),
      });
      if (current.signal.aborted) return;
      if (!response.ok) { setStatus("failed"); return; }
      setStatus("accepted");
    } catch (error: unknown) {
      if (!current.signal.aborted) {
        console.warn("[workspace] Task scheduling unavailable", error instanceof Error ? error.name : "UnknownError");
        setStatus("failed");
      }
    }
  }
  return <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label className="text-xs text-muted-foreground" htmlFor="shared-background-task">Background task</label>
    <div className="flex gap-2">
      <input id="shared-background-task" className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1" maxLength={2000}
        value={draft} disabled={status === "sending"} placeholder="Ask your agent to save something…"
        onChange={(event) => { setDraft(event.target.value); pending.current = null; setStatus("idle"); }} />
      <button type="submit" className="shrink-0 rounded-md border border-border px-2 py-1" disabled={!draft.trim() || status === "sending" || status === "accepted"}>
        {status === "sending" ? "Scheduling…" : status === "failed" ? "Retry task" : "Run background task"}
      </button>
    </div>
    {status === "failed" ? <p role="alert" className="text-xs">Task scheduling is unavailable. Retrying safely checks the same task.</p> : null}
    {status === "accepted" ? <p className="text-xs" aria-live="polite">Task queued. Your agent will save its output to your workspace.</p> : null}
    <p className="text-xs text-muted-foreground">Preview: live Chat and Terminal connections are unavailable. Background tasks use your saved workspace.</p>
  </form>;
}
