import { useEffect, useRef, useState } from "react";
import type { SiteRecord } from "@matrix-os/contracts";
import { SiteClientError, siteActionError, type SiteClient, type SiteSubmissionsPage } from "../../lib/site-client";

type SiteView = {
  site: SiteRecord | null; loading: boolean; pending: boolean; loadFailed: boolean;
  error: string | null; message: string | null; submissions: SiteSubmissionsPage | null; pageCursor: string | null;
  conflict: boolean; metadataEpoch: number;
};
function initialView(): SiteView {
  return { site: null, loading: true, pending: false, loadFailed: false, error: null, message: null, submissions: null, pageCursor: null, conflict: false, metadataEpoch: 0 };
}
// Keep try/finally outside the compiled hook while always releasing pending state.
async function runSiteAction<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>, success: (value: T) => void, failure: (error: unknown) => void, finish: () => void): Promise<boolean> {
  try {
    const result = await work(signal);
    if (signal.aborted) return false;
    success(result); return true;
  } catch (error: unknown) {
    if (!signal.aborted) failure(error);
    return false;
  } finally { if (!signal.aborted) finish(); }
}
export function useAppSite(appSlug: string, client: SiteClient) {
  const [view, setView] = useState(initialView);
  const [source, setSource] = useState({ appSlug, client });
  const [retry, setRetry] = useState(0);
  const lifecycle = useRef<AbortController | null>(null);
  const actionPending = useRef(false);
  // Reset during an identity change before children render stale owner state.
  // The panel also keys app sessions; this handles a replaced runtime client.
  if (source.appSlug !== appSlug || source.client !== client) {
    setSource({ appSlug, client }); setView(initialView());
  }
  const patch = (value: Partial<SiteView>) => setView(current => ({ ...current, ...value }));
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller; actionPending.current = false;
    void client.get(appSlug, controller.signal).then(record => {
      if (!controller.signal.aborted) setView(current => ({ ...current, site: record }));
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[app-sites] publication load failed", failure instanceof Error ? "Error" : "UnknownError");
      setView(current => ({ ...current, loadFailed: true, error: "Publishing is unavailable. Please try again." }));
    }).finally(() => {
      if (!controller.signal.aborted) setView(current => ({ ...current, loading: false }));
    });
    return () => controller.abort();
  }, [appSlug, client, retry]);
  function action<T>(work: (signal: AbortSignal) => Promise<T>, success: (value: T) => void, notice?: string, publicationMutation = false): Promise<boolean> {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || actionPending.current) return Promise.resolve(false);
    actionPending.current = true; patch({ pending: true, error: null, message: null });
    return runSiteAction(controller.signal, work, value => {
      success(value); if (notice) patch({ message: notice });
    }, failure => {
      console.warn("[app-sites] action failed", failure instanceof Error ? "Error" : "UnknownError");
      setView(current => ({ ...current, error: siteActionError(failure), conflict: current.conflict || (publicationMutation && failure instanceof SiteClientError && failure.status === 409) }));
    }, () => { actionPending.current = false; patch({ pending: false }); });
  }
  return { ...view, action,
    mutate: <T,>(work: (signal: AbortSignal) => Promise<T>, success: (value: T) => void, notice?: string) => action(work, success, notice, true),
    refresh: () => { setView(initialView()); setRetry(value => value + 1); },
    // Recovery updates server truth without remounting the owner's unsaved form.
    reloadPublication: () => action(signal => client.get(appSlug, signal), site => patch({ site, conflict: false, submissions: null, pageCursor: null }), "Publication refreshed. Your draft details were kept. Review deployment before publishing."),
    // Only a confirmed owner mutation replaces local metadata and review state.
    setSite: (site: SiteRecord | null) => setView(current => ({ ...current, site, conflict: false, metadataEpoch: current.metadataEpoch + 1 })),
    loadSubmissions: (cursor: string | null = null) => action(signal => client.submissions(appSlug, cursor, signal), page => patch({ submissions: page, pageCursor: cursor })),
    removeSubmission: (id: string) => action(async signal => {
      await client.deleteSubmission(appSlug, id, signal);
      if (signal.aborted) return null;
      // Invalidate deleted records and cached exports before the stable page reload.
      patch({ submissions: null });
      return client.submissions(appSlug, view.pageCursor, signal);
    }, page => { if (page) patch({ submissions: page }); }, "Submission deleted."),
  };
}
