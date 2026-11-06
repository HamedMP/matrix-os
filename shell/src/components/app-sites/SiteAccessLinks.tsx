"use client";
import { useEffect, useState } from "react";
import { SITE_MAX_ACCESS_LINKS, type SiteAccessLinkSummary, type SiteRecord } from "@matrix-os/contracts";
import { Button } from "@matrix-os/ui";
import { siteActionError, type SiteClient } from "../../lib/site-client";
import { formatSiteDate } from "./format-site-date";
import type { useAppSite } from "./use-app-site";

type AppSiteState = ReturnType<typeof useAppSite>;

export function SiteAccessLinks({ appSlug, client, site, state, disabled }: {
  appSlug: string; client: SiteClient; site: SiteRecord; state: AppSiteState; disabled: boolean;
}) {
  const [links, setLinks] = useState<SiteAccessLinkSummary[]>([]);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (site.status !== "published" || site.accessMode !== "private_link") return;
    const controller = new AbortController();
    void client.accessLinks(appSlug, controller.signal).then(page => {
      if (!controller.signal.aborted) { setLinks(page.links); setLoadError(null); setLinksLoaded(true); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(siteActionError(error));
    });
    return () => controller.abort();
  }, [appSlug, client, site.id, site.status, site.accessMode, reload]);
  if (site.status !== "published" || site.accessMode !== "private_link") return null;
  const create = () => state.mutate(
    signal => client.createAccessLink(appSlug, { baseRevision: site.revision }, signal),
    result => { setLinks(current => [result.link, ...current.filter(link => link.id !== result.link.id)]); setGeneratedUrl(result.url); },
    "One-time link created.",
  );
  const revoke = (linkId: string) => state.action(async signal => {
    await client.revokeAccessLink(appSlug, linkId, signal); return linkId;
  }, revoked => {
    setLinks(current => current.filter(link => link.id !== revoked));
    setGeneratedUrl(current => current?.includes(revoked) ? null : current);
  }, "Link revoked.");
  return <section aria-label="One-time links" className="space-y-3 rounded-lg border p-3">
    <div className="space-y-1"><p className="text-sm font-medium">Private — one-time links</p>
      <p className="text-xs">Each link can be claimed by one browser. Unclaimed links expire after 7 days; access lasts 30 days.</p></div>
    <Button size="sm" disabled={disabled || !linksLoaded || links.length >= SITE_MAX_ACCESS_LINKS} onClick={() => void create()}>Create one-time link</Button>
    {generatedUrl ? <div className="ph-no-capture space-y-2 rounded border p-2" role="status">
      <p className="text-xs font-medium">Save this URL now. It will not be shown again.</p>
      <p className="break-all text-sm" data-ph-mask="true">{generatedUrl}</p>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void state.action(async () => navigator.clipboard.writeText(generatedUrl), () => {}, "One-time link copied.")}>Copy one-time link</Button>
    </div> : null}
    {loadError ? <div className="space-y-2"><p role="alert" className="text-sm">{loadError}</p><Button size="sm" variant="secondary" disabled={disabled} onClick={() => { setLinksLoaded(false); setLoadError(null); setReload(value => value + 1); }}>Retry link list</Button></div> : null}
    {links.length ? <ul className="space-y-2">{links.map(link => <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-xs">
      <span><strong>{link.status === "unclaimed" ? "Unclaimed" : link.status === "claimed" ? "Claimed" : "Expired"}</strong> · Created {formatSiteDate(link.createdAt)} · {link.status === "claimed" && link.sessionExpiresAt ? `Access expires ${formatSiteDate(link.sessionExpiresAt)}` : `Claim expires ${formatSiteDate(link.claimExpiresAt)}`}</span>
      <Button size="sm" variant="destructive" disabled={disabled} onClick={() => void revoke(link.id)}>Revoke link</Button>
    </li>)}</ul> : <p className="text-xs">No one-time links yet.</p>}
  </section>;
}
