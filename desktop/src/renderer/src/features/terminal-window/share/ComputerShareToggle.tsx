// Spec 2710 layer 6: from one shared terminal, share every terminal on its
// computer with the same people (and let editors open new tabs), or stop.
import { useEffect, useState } from "react";
import { Button } from "@matrix-os/ui";
import type { TeamShareApi } from "./team-share";
import { readComputerShare, shareComputer, stopSharingComputer } from "./team-share";

const secondaryText = { color: "var(--text-secondary, var(--color-muted-foreground))" };

export function ComputerShareToggle({ api, scopeId }: { api: TeamShareApi; scopeId: string }) {
  const [shared, setShared] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- reads the computer's sharing state when the share dialog shows this terminal's access.
  useEffect(() => {
    let active = true;
    readComputerShare(api, scopeId).then((value) => { if (active) setShared(value); }, (error: unknown) => {
      console.warn("[terminal-window] computer share state unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (active) setShared(false);
    });
    return () => { active = false; };
  }, [api, scopeId]);
  const toggle = async () => {
    if (busy || shared === null) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = !shared;
      if (next) await shareComputer(api, scopeId);
      else await stopSharingComputer(api, scopeId);
      setShared(next);
    } catch (error: unknown) {
      console.warn("[terminal-window] computer share change failed:", error instanceof Error ? error.name : "UnknownError");
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  if (shared === null) return null;
  return (
    <section aria-label="Share this computer" className="flex flex-col gap-1.5 rounded-md border p-2.5" style={{ borderColor: "var(--border-default)" }}>
      <p>{shared
        ? "Every terminal on this computer is shared with these people, and Editors can open new ones."
        : "Share every terminal on this computer with the same people, and let Editors open new ones."}</p>
      {failed ? <p role="alert">Couldn't change this. Add someone above first, then try again.</p> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" variant={shared ? "destructive" : "secondary"} disabled={busy} onClick={() => { void toggle(); }}>
          {shared ? "Stop sharing this computer" : "Share whole computer"}
        </Button>
        {busy ? <span role="status" style={secondaryText}>Working…</span> : null}
      </div>
    </section>
  );
}
