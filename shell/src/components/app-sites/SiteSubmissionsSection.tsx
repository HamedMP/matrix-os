"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { SiteClient } from "../../lib/site-client";
import { SiteSubmissions } from "./SiteSubmissions";
import { useAppSite } from "./use-app-site";

/**
 * Visitor submissions for a published app with public forms, shown inside the
 * Share popover's Public tab (Web and Electron). Loads only when opened.
 */
export function SiteSubmissionsSection({ appSlug, client }: { appSlug: string; client: SiteClient }) {
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
