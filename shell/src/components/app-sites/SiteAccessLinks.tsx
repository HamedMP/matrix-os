"use client";
import { useEffect, useState } from "react";
import { SITE_MAX_ACCESS_LINKS, type SiteAccessLinkSummary, type SiteRecord } from "@matrix-os/contracts";
import { Button } from "@matrix-os/ui";
import { siteActionError, type SiteClient } from "../../lib/site-client";
import { formatSiteDate } from "./format-site-date";
import type { useAppSite } from "./use-app-site";

type AppSiteState = ReturnType<typeof useAppSite>;

// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- one authoritative one-time-link lifecycle intentionally serves the standard publishing view and the collaboration-style invite presentation so their create/revoke/secret handling cannot drift.
export function SiteAccessLinks({ appSlug, client, site, state, disabled, variant = "default" }: {
  appSlug: string; client: SiteClient; site: SiteRecord | null; state: AppSiteState; disabled: boolean; variant?: "default" | "invite";
}) {
  const [links, setLinks] = useState<SiteAccessLinkSummary[]>([]);
  const [generatedLink, setGeneratedLink] = useState<{ url: string; publicationKey: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const invite = variant === "invite";
  const ready = site?.status === "published" && site.accessMode === "private_link";
  const publicationKey = ready && site ? `${site.id}:${site.revision}` : null;
  const generatedUrl = generatedLink?.publicationKey === publicationKey ? generatedLink.url : null;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void client.accessLinks(appSlug, controller.signal).then(page => {
      if (!controller.signal.aborted) { setLinks(page.links); setLoadError(null); setLinksLoaded(true); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(siteActionError(error));
    });
    return () => controller.abort();
  }, [appSlug, client, ready, site?.id, reload]);
  if (!invite && !ready) return null;
  const create = () => !site || !ready || !publicationKey ? Promise.resolve(false) : state.mutate(
    signal => client.createAccessLink(appSlug, { baseRevision: site.revision }, signal),
    result => { setLinks(current => [result.link, ...current.filter(link => link.id !== result.link.id)]); setGeneratedLink({ url: result.url, publicationKey }); },
    invite ? "Invite link created." : "One-time link created.",
  );
  const revoke = (linkId: string) => state.action(async signal => {
    await client.revokeAccessLink(appSlug, linkId, signal); return linkId;
  }, revoked => {
    setLinks(current => current.filter(link => link.id !== revoked));
    setGeneratedLink(current => current?.url.includes(revoked) ? null : current);
  }, "Link revoked.");
  const readinessCopy = ready
    ? "One-time access for one browser. Unclaimed links expire after 7 days."
    : site?.status === "published"
      ? "Switch publishing to Private — one-time links below to enable invites."
      : "Publish privately below to enable one-time invite links.";
  return <section aria-label={invite ? "Invite link" : "One-time links"} className={invite ? "space-y-3 border-t pt-3" : "space-y-3 rounded-lg border p-3"}>
    <div className={invite ? "flex items-center justify-between gap-4" : "space-y-1"}>
      <div className={invite ? "flex min-w-0 items-start gap-3" : "space-y-1"}>
        {invite ? <span aria-hidden="true" className="mt-0.5 text-base">↗</span> : null}
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{invite ? "One-time invite link" : "Private — one-time links"}</p>
          <p className="text-xs">{invite ? readinessCopy : "Each link can be claimed by one browser. Unclaimed links expire after 7 days; access lasts 30 days."}</p>
        </div>
      </div>
      {invite ? <Button size="sm" disabled={disabled || !ready || !linksLoaded || links.length >= SITE_MAX_ACCESS_LINKS} onClick={() => void create()}>Create invite link</Button> : null}
    </div>
    {!invite ? <Button size="sm" disabled={disabled || !linksLoaded || links.length >= SITE_MAX_ACCESS_LINKS} onClick={() => void create()}>Create one-time link</Button> : null}
    {ready && generatedUrl ? <div className="ph-no-capture space-y-2 rounded border p-2" role="status">
      <p className="text-xs font-medium">Save this URL now. It will not be shown again.</p>
      <p className="break-all text-sm" data-ph-mask="true">{generatedUrl}</p>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void state.action(async () => navigator.clipboard.writeText(generatedUrl), () => {}, invite ? "Invite link copied." : "One-time link copied.")}>{invite ? "Copy invite link" : "Copy one-time link"}</Button>
    </div> : null}
    {loadError ? <div className="space-y-2"><p role="alert" className="text-sm">{loadError}</p><Button size="sm" variant="secondary" disabled={disabled} onClick={() => { setLinksLoaded(false); setLoadError(null); setReload(value => value + 1); }}>Retry link list</Button></div> : null}
    {ready && links.length ? <ul className="space-y-2">{links.map(link => <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-xs">
      <span><strong>{link.status === "unclaimed" ? "Unclaimed" : link.status === "claimed" ? "Claimed" : "Expired"}</strong> · Created {formatSiteDate(link.createdAt)} · {link.status === "claimed" && link.sessionExpiresAt ? `Access expires ${formatSiteDate(link.sessionExpiresAt)}` : `Claim expires ${formatSiteDate(link.claimExpiresAt)}`}</span>
      <Button size="sm" variant="destructive" disabled={disabled} onClick={() => void revoke(link.id)}>Revoke link</Button>
    </li>)}</ul> : ready ? <p className="text-xs">No invite links yet.</p> : null}
  </section>;
}
