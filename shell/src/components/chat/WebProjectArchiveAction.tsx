"use client";

import { useState } from "react";

export function WebProjectArchiveAction({ projectId, projectSlug, projectName, onArchive }: {
  projectId: string;
  projectSlug: string;
  projectName: string;
  onArchive(projectId: string, projectSlug: string, projectName: string): Promise<boolean>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return <div className="px-2 pb-1 text-xs">
    {!confirm ? <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setConfirm(true)}>Archive chats in {projectName}</button>
      : <div role="alertdialog" aria-label={`Archive chats in ${projectName}?`} className="rounded-lg border border-border p-2">
        <p>Archive all idle chats in {projectName}? Running chats will be skipped.</p>
        {error ? <p role="alert" className="text-destructive">Project chats could not be archived. Try again.</p> : null}
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={pending} onClick={() => { setConfirm(false); setError(false); }}>Cancel</button>
          <button type="button" disabled={pending} className="font-semibold text-primary" onClick={() => {
            setPending(true);
            setError(false);
            void onArchive(projectId, projectSlug, projectName).then(done => { if (done) setConfirm(false); else setError(true); })
              .catch((cause: unknown) => { console.warn("[web-projects] Archive failed:", cause instanceof Error ? cause.name : "UnknownError"); setError(true); })
              .finally(() => setPending(false));
          }}>Archive chats</button>
        </div>
      </div>}
  </div>;
}
