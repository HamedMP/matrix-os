"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { SiteClient } from "../../lib/site-client";
import { SiteSubmissions } from "./SiteSubmissions";
import { useAppSite } from "./use-app-site";

const SAVED_RESPONSES_PROBE_TIMEOUT_MS = 10_000;

/**
 * Visitor submissions for a published app, shown inside the Share popover's
 * Public tab (Web and Electron). Apps that declare forms always show it; an app
 * whose forms were removed keeps it while responses from earlier versions remain,
 * so the owner can still read, export, or delete them. Rows load only when opened.
 */
export function SiteSubmissionsSection({ appSlug, client, formsDeclared }: { appSlug: string; client: SiteClient; formsDeclared: boolean }) {
  const hasSaved = useHasSavedResponses(appSlug, client, !formsDeclared);
  if (!formsDeclared && !hasSaved) return null;
  return <SubmissionsDisclosure appSlug={appSlug} client={client} />;
}

/** True once a first page shows saved responses; also true if the check fails, so a broken check never hides them. */
function useHasSavedResponses(appSlug: string, client: SiteClient, enabled: boolean): boolean {
  const [result, setResult] = useState<{ appSlug: string; hasSaved: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), SAVED_RESPONSES_PROBE_TIMEOUT_MS);
    client.submissions(appSlug, null, controller.signal).then(
      (page) => { if (!disposed) setResult({ appSlug, hasSaved: page.submissions.length > 0 }); },
      (error: unknown) => {
        if (disposed) return;
        console.warn("[site-submissions] saved-response check failed", error instanceof Error ? error.name : "unknown");
        setResult({ appSlug, hasSaved: true });
      },
    ).finally(() => clearTimeout(timer));
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [appSlug, client, enabled]);
  return enabled && result?.appSlug === appSlug && result.hasSaved;
}

function SubmissionsDisclosure({ appSlug, client }: { appSlug: string; client: SiteClient }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return <div className="flex flex-col gap-2 border-t border-[var(--share-border)] pt-3">
    <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}
      className="self-start bg-transparent p-0 text-left text-[13px] font-medium text-[var(--share-fg)] underline-offset-2 hover:underline">
      Visitor submissions
    </button>
    {open ? <LoadedSubmissions id={contentId} appSlug={appSlug} client={client} /> : null}
  </div>;
}

function LoadedSubmissions({ id, appSlug, client }: { id: string; appSlug: string; client: SiteClient }) {
  const state = useAppSite(appSlug, client);
  const requested = useRef(false);
  const ready = !state.loading && !state.loadFailed;
  const { loadSubmissions } = state;
  useEffect(() => {
    // First page once the publication is loaded; later pages come from the list's own controls.
    if (!ready || requested.current) return;
    requested.current = true;
    void loadSubmissions();
  }, [ready, loadSubmissions]);
  return <div className="flex flex-col gap-2 text-xs">
    {state.error ? <p role="alert" className="m-0 text-[var(--share-danger-fg)]">{state.error}</p> : null}
    <SiteSubmissions id={id} appSlug={appSlug} client={client} state={state} />
  </div>;
}
