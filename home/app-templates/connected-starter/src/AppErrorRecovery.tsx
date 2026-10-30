import React, { useState } from "react";

/** Reuse for caught data errors without discarding the owner's unsaved edits. */
export function AppErrorRecovery({ message, retry }: { message: string; retry: () => void }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [details, setDetails] = useState(false);
  async function repair() {
    if (status === "sending") return;
    setStatus("sending");
    try {
      if (!window.MatrixOS?.repair) throw new Error("Repair chat unavailable");
      await window.MatrixOS.repair({ operation: "persistence", message });
      setStatus("sent");
    } catch (error) {
      console.warn("[app-error-recovery] repair failed", error instanceof Error ? error.name : "UnknownError");
      setStatus("failed");
    }
  }
  return <div className="notice error app-error-recovery" role="alert">
    <p>{message}</p>
    <div className="app-error-actions">
      <button type="button" disabled={status === "sending"} onClick={() => void repair()}>Fix with Matrix</button>
      <button type="button" onClick={retry}>Try again</button>
      <button type="button" aria-expanded={details} onClick={() => setDetails(value => !value)}>Details</button>
    </div>
    {details ? <pre>{message}</pre> : null}
    {status === "failed" ? <p>Could not open a repair chat. Try again.</p> : null}
    {status === "sent" ? <p>Matrix received the error context. Retry saving when ready.</p> : null}
  </div>;
}
