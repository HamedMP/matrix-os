import { useEffect, useRef, useState } from "react";
import { Button } from "@matrix-os/ui";
import { SiteClientError, type SiteClient } from "../../lib/site-client";
import { formatSiteDate } from "./format-site-date";
import type { useAppSite } from "./use-app-site";

type SiteSubmissionsProps = { appSlug: string; client: SiteClient; state: ReturnType<typeof useAppSite> };
export function SiteSubmissions(props: SiteSubmissionsProps) {
  // A confirmed deletion invalidates the page before its reload. Remounting
  // drops any cached bytes even if that reload fails or returns another page.
  const pageKey = JSON.stringify([props.appSlug, props.state.site?.id, props.state.pageCursor,
    props.state.submissions?.submissions.map(row => row.id) ?? null]);
  return <SiteSubmissionsPage key={pageKey} {...props} />;
}
function SiteSubmissionsPage({ appSlug, client, state }: SiteSubmissionsProps) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [download, setDownload] = useState<Blob | null>(null);
  const mounted = useRef(true);
  const exportGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; exportGeneration.current += 1; };
  }, []);
  function invalidateExport() { exportGeneration.current += 1; setDownload(null); }
  function exportPage() {
    const generation = exportGeneration.current;
    void state.action(async signal => {
      const blob = await client.exportSubmissions(appSlug, state.pageCursor, signal);
      if (!mounted.current || generation !== exportGeneration.current || signal.aborted) throw new SiteClientError(409);
      return blob;
    }, blob => {
      if (!mounted.current || generation !== exportGeneration.current) return;
      setDownload(blob); downloadSubmissionExport(appSlug, blob);
    }, "This page of submissions was exported.");
  }
  return <section aria-label="Visitor submissions" className="ph-no-capture space-y-3 rounded-lg border p-3">
    <h3 className="font-medium">Visitor submissions</h3>
    <p className="text-xs">Visitor details are private. Updating or restoring a version keeps these records.</p>
    <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={state.pending} onClick={() => { invalidateExport(); void state.loadSubmissions(); }}>Refresh submissions</Button><Button variant="secondary" size="sm" disabled={state.pending || !state.submissions} onClick={exportPage}>Export this page</Button></div>
    {download ? <p className="text-xs">Export ready. <Button size="sm" variant="ghost" disabled={state.pending} onClick={() => void state.action(async () => downloadSubmissionExport(appSlug, download), () => {})}>Download again</Button></p> : null}
    {!state.submissions ? <p className="text-sm">{state.pending ? "Loading submissions…" : "Load submissions to view visitor responses."}</p> : !state.submissions.submissions.length ? <p className="text-sm">No visitor submissions yet.</p> : <ul className="space-y-3">
      {state.submissions.submissions.map(row => <li key={row.id} className="space-y-2 border-t pt-2">
        <p className="text-xs">{row.formId} · {formatSiteDate(row.createdAt)}</p>
        <dl className="space-y-1 text-sm">{Object.entries(row.fields).map(([key, value]) => <div key={key}><dt className="font-medium">{key}</dt><dd className="break-words whitespace-pre-wrap">{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl>
        {deleting === row.id ? <div className="flex flex-wrap gap-2"><p className="w-full text-xs">Delete this saved response permanently?</p><Button size="sm" variant="destructive" disabled={state.pending} onClick={() => void state.removeSubmission(row.id)}>Confirm delete</Button><Button size="sm" variant="secondary" disabled={state.pending} onClick={() => setDeleting(null)}>Cancel delete</Button></div> : <Button size="sm" variant="secondary" disabled={state.pending} onClick={() => setDeleting(row.id)}>Delete submission</Button>}
      </li>)}
    </ul>}
    {state.submissions?.nextCursor ? <Button variant="secondary" size="sm" disabled={state.pending} onClick={() => { invalidateExport(); void state.loadSubmissions(state.submissions!.nextCursor); }}>Next page</Button> : null}
  </section>;
}

function downloadSubmissionExport(appSlug: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${appSlug}-submissions.json`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    // No object URL survives this synchronous action, invalidation, or unmount.
    } finally { URL.revokeObjectURL(url); }
}
