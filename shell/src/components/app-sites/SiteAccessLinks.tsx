"use client";
import { useEffect, useRef, useState } from "react";
import { type SiteAccessLinkSummary, type SiteRecord } from "@matrix-os/contracts";
import { Button } from "@matrix-os/ui";
import { siteActionError, type SiteClient } from "../../lib/site-client";
import { formatSiteDate } from "./format-site-date";
import type { useAppSite } from "./use-app-site";

type AppSiteState = ReturnType<typeof useAppSite>;

// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- one authoritative one-time-link lifecycle intentionally serves the standard publishing view and the collaboration-style invite presentation so their create/revoke/secret handling cannot drift.
export function SiteAccessLinks({ appSlug, client, site, state, disabled, variant = "default", onPublicationChange }: {
  appSlug: string; client: SiteClient; site: SiteRecord | null; state: AppSiteState; disabled: boolean; variant?: "default" | "invite";
  onPublicationChange?: (site: SiteRecord) => void;
}) {
  const [links, setLinks] = useState<SiteAccessLinkSummary[]>([]);
  const [generatedLink, setGeneratedLink] = useState<{ url: string; publicationKey: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const linksMutationVersion = useRef(0);
  const invite = variant === "invite";
  const ready = site?.status === "published" && site.accessMode === "private_link";
  const publicationKey = ready && site ? `${site.id}:${site.revision}` : null;
  const generatedUrl = generatedLink?.publicationKey === publicationKey ? generatedLink.url : null;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const requestVersion = linksMutationVersion.current;
    void client.accessLinks(appSlug, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      if (linksMutationVersion.current !== requestVersion) { setReload(value => value + 1); return; }
      setLinks(page.links); setNextCursor(page.nextCursor); setLoadError(null); setLinksLoaded(true);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (linksMutationVersion.current !== requestVersion) { setReload(value => value + 1); return; }
      setLoadError(siteActionError(error));
    });
    return () => controller.abort();
  }, [appSlug, client, ready, site?.id, reload]);
  if (!invite && !ready) return null;
  const create = () => state.mutate(async signal => {
    let publication = site;
    let publicationChanged = false;
    if (!publication || publication.status !== "published") {
      const reviewedConfig = await client.getConfig(appSlug, signal);
      publication = await client.deploy(appSlug, {
        title: publication?.title ?? appSlug,
        description: publication?.description ?? "",
        slug: publication?.slug ?? null,
        accessMode: "private_link",
        baseRevision: publication?.revision ?? 0,
        reviewedConfig,
      }, signal);
      publicationChanged = true;
    } else if (publication.accessMode !== "private_link") {
      publication = await client.update(appSlug, {
        title: publication.title,
        description: publication.description,
        slug: publication.slug,
        accessMode: "private_link",
        baseRevision: publication.revision,
      }, signal);
      publicationChanged = true;
    }
    if (publicationChanged) onPublicationChange?.(publication);
    const created = await client.createAccessLink(appSlug, { baseRevision: publication.revision }, signal);
    return { ...created, publication };
  },
    result => {
      linksMutationVersion.current += 1;
      setLinksLoaded(true);
      setLinks(current => [result.link, ...current.filter(link => link.id !== result.link.id)]);
      setGeneratedLink({ url: result.url, publicationKey: `${result.publication.id}:${result.publication.revision}` });
    },
    invite ? "Invite link created." : "One-time link created.",
  );
  const revoke = (linkId: string) => state.action(async signal => {
    await client.revokeAccessLink(appSlug, linkId, signal); return linkId;
  }, revoked => {
    linksMutationVersion.current += 1;
    setLinks(current => current.filter(link => link.id !== revoked));
    setGeneratedLink(current => current?.url.includes(revoked) ? null : current);
  }, "Link revoked.");
  const loadMore = () => {
    if (!nextCursor) return Promise.resolve(false);
    const requestVersion = linksMutationVersion.current;
    return state.action(
      signal => client.accessLinks(appSlug, signal, nextCursor),
      page => {
        if (linksMutationVersion.current !== requestVersion) { setReload(value => value + 1); return; }
        setLinks(current => [...current, ...page.links.filter(link => !current.some(existing => existing.id === link.id))]);
        setNextCursor(page.nextCursor);
      },
    );
  };
  const readinessCopy = "Unclaimed links expire after 7 days.";
  return <section aria-label={invite ? "Invite link" : "One-time links"} className={invite ? "space-y-2 border-t pt-2" : "space-y-3 rounded-lg border p-3"}>
    <div className={invite ? "flex items-center justify-between gap-4" : "space-y-1"}>
      <div className={invite ? "flex min-w-0 items-start gap-3" : "space-y-1"}>
        {invite ? <span aria-hidden="true" className="mt-0.5 text-base">↗</span> : null}
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{invite ? "One-time invite link" : "Private — one-time links"}</p>
          <p className="text-xs">{invite ? readinessCopy : "Each link can be claimed by one browser. Unclaimed links expire after 7 days; access lasts 30 days."}</p>
        </div>
      </div>
      {invite ? <Button aria-label="Create invite link" size="sm" disabled={disabled || (ready && !linksLoaded)} onClick={() => void create()}>Create</Button> : null}
    </div>
    {!invite ? <Button size="sm" disabled={disabled || !linksLoaded} onClick={() => void create()}>Create one-time link</Button> : null}
    {ready && generatedUrl ? <div className="ph-no-capture space-y-2 rounded border p-2" role="status">
      <p className="text-xs font-medium">Save this URL now. It will not be shown again.</p>
      <p className="break-all text-sm" data-ph-mask="true">{generatedUrl}</p>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void state.action(async () => navigator.clipboard.writeText(generatedUrl), () => {}, invite ? "Invite link copied." : "One-time link copied.")}>{invite ? "Copy invite link" : "Copy one-time link"}</Button>
    </div> : null}
    {loadError ? <div className="space-y-2"><p role="alert" className="text-sm">{loadError}</p><Button size="sm" variant="secondary" disabled={disabled} onClick={() => { setLinksLoaded(false); setLoadError(null); setReload(value => value + 1); }}>Retry link list</Button></div> : null}
    {ready && links.length ? <ul className="space-y-2">{links.map(link => <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-xs">
      <span><strong>{link.status === "unclaimed" ? "Unclaimed" : link.status === "claimed" ? "Claimed" : "Expired"}</strong> · Created {formatSiteDate(link.createdAt)} · {link.status === "claimed" && link.sessionExpiresAt ? `Access expires ${formatSiteDate(link.sessionExpiresAt)}` : `Claim expires ${formatSiteDate(link.claimExpiresAt)}`}</span>
      <Button size="sm" variant="destructive" disabled={disabled} onClick={() => void revoke(link.id)}>Revoke link</Button>
    </li>)}</ul> : ready ? <p className="text-xs">{invite ? "No invite links yet." : "No one-time links yet."}</p> : null}
    {ready && nextCursor ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void loadMore()}>Load more links</Button> : null}
  </section>;
}
