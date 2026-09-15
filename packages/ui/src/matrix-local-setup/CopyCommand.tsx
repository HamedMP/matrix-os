import { useEffect, useRef, useState } from "react";

export function CopyCommand({ title, command, testId }: { title: string; command: string; testId?: string }) {
  const [feedback, setFeedback] = useState<"copied" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function copy() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(command);
      if (mounted.current) setFeedback("copied");
    } catch (error: unknown) {
      console.warn("[local-setup] clipboard unavailable", error instanceof Error ? "Error" : "Unknown");
      if (mounted.current) setFeedback("error");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: "var(--border-subtle, var(--border))" }}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{title}</span>
        <button type="button" aria-label={`Copy ${title}`} data-testid={testId} disabled={busy}
          onClick={() => void copy()} className="shrink-0 rounded-md border px-3 py-1 text-xs focus-visible:outline focus-visible:outline-2 disabled:opacity-50">
          {busy ? "Copying…" : "Copy"}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all text-xs leading-relaxed"><code>{command}</code></pre>
      {feedback === "copied" && <p role="status" className="mt-2 text-xs">Copied</p>}
      {feedback === "error" && <p role="alert" className="mt-2 text-xs">Could not copy. Select and copy the text manually.</p>}
    </div>
  );
}
