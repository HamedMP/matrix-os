import { useEffect, useState } from "react";
import { Button } from "@matrix-os/ui";
import { invoke } from "../../lib/operator";

type ReadState = { status: "loading" } | { status: "failed" } | { status: "ready"; text: string };

export function FinishedTerminalOutput({ terminalKey, terminalId, focused, onDisplayed }: {
  terminalKey: string; terminalId: string; focused: boolean;
  onDisplayed(key: string): () => void;
}) {
  const [read, setRead] = useState<ReadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void invoke("local-terminal:history", { id: terminalId }).then((result) => {
      if (current) setRead(result.ok ? { status: "ready", text: result.text } : { status: "failed" });
    }, (error: unknown) => {
      console.warn("[terminal-window] saved output unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (current) setRead({ status: "failed" });
    });
    return () => { current = false; };
  }, [attempt, terminalId]);

  useEffect(() => {
    if (read.status === "ready" && focused) return onDisplayed(terminalKey);
    return undefined;
  }, [focused, onDisplayed, read.status, terminalKey]);

  if (read.status === "loading") return <p role="status" className="p-3 text-xs">Loading saved output…</p>;
  if (read.status === "failed") {
    return (
      <div className="flex items-center gap-2 p-3 text-xs">
        <p role="alert">Couldn't load saved output.</p>
        <Button variant="secondary" size="sm" onClick={() => {
          setRead({ status: "loading" });
          setAttempt((value) => value + 1);
        }}>Retry</Button>
      </div>
    );
  }
  if (!read.text) return <p className="p-3 text-xs">This terminal ended without saved output.</p>;
  return (
    <pre aria-label="Saved terminal output" tabIndex={0}
      className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px]">
      {read.text}
    </pre>
  );
}
