import { useEffect, useRef, useState } from "react";
import type { SiteAccessLinkSummary, SiteRecord } from "@matrix-os/contracts";
import type { EmailInvitationAdapter, EmailInvitationSummary } from "./email-invitations";
import { needsModeSwitchConfirm, pageModeOf, type PageMode, type PageModeTarget } from "./share-model";
import { errorStatus, isAbortError, shareErrorMessage, type ShareSiteClient } from "./share-site-client";

export interface PublicMetadata { title: string; description: string; slug: string | null }

/** What the owner asked for. Applied immediately or after the mode-switch confirm. */
export type ShareModeRequest =
  | { to: "private_email"; email: string }
  | { to: "private_link" }
  | { to: "public"; metadata: PublicMetadata };

export type ShareOperation = "load" | "invite" | "invite_change" | "link_create" | "link_revoke" | "publish" | "unpublish" | "switch";

interface ShareView {
  site: SiteRecord | null;
  loading: boolean;
  loadFailed: boolean;
  operation: ShareOperation | null;
  error: { operation: ShareOperation; message: string } | null;
  links: SiteAccessLinkSummary[];
  linksNextCursor: string | null;
  /** One-time URLs returned at creation. Kept in memory only; never re-fetchable. */
  freshLinks: Record<string, string>;
  invitations: EmailInvitationSummary[];
  emailRevision: number;
  emailActive: boolean;
  pendingSwitch: ShareModeRequest | null;
  /** Friendly path rejected by the platform's atomic alias claim. */
  slugConflict: string | null;
}

const initialView = (): ShareView => ({
  site: null, loading: true, loadFailed: false, operation: null, error: null,
  links: [], linksNextCursor: null, freshLinks: {}, invitations: [], emailRevision: 0, emailActive: false,
  pendingSwitch: null, slugConflict: null,
});

const MAX_FRESH_LINKS = 20;

/**
 * Owns one app's Matrix.page sharing state. The window-header host keeps it
 * mounted so the trigger label (Share / Live) and the lazily mounted popover
 * read the same server truth without a second fetch or a child-to-parent push.
 */
export function useShareController({ appSlug, appName, client, emailInvites }: {
  appSlug: string; appName: string; client: ShareSiteClient | null; emailInvites: EmailInvitationAdapter | null;
}) {
  const [view, setView] = useState(initialView);
  const [reload, setReload] = useState(0);
  const [source, setSource] = useState({ appSlug, client, emailInvites });
  // Reset during render on an identity change so no frame shows the previous app's access.
  if (source.appSlug !== appSlug || source.client !== client || source.emailInvites !== emailInvites) {
    setSource({ appSlug, client, emailInvites }); setView(initialView());
  }
  const lifecycle = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const patch = (value: Partial<ShareView>) => setView((current) => ({ ...current, ...value }));
  const pageMode: PageMode = pageModeOf(view.site, view.emailActive);

  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    lifecycle.current = controller; busy.current = false;
    const signal = controller.signal;
    let current = true;
    void (async () => {
      try {
        const site = await client.get(appSlug, signal);
        const emailActive = emailInvites?.active(appSlug) ?? false;
        // react-doctor-disable-next-line react-doctor/async-defer-await -- the early return below is the effect-cancellation guard; it must follow the awaits.
        const [links, page] = await Promise.all([
          site?.status === "published" && site.accessMode === "private_link" ? client.accessLinks(appSlug, signal) : null,
          emailActive && emailInvites ? emailInvites.list(appSlug, signal) : null,
        ]);
        if (!current) return;
        setView((previous) => ({
          ...previous, site, loading: false, loadFailed: false, emailActive,
          links: links?.links ?? [], linksNextCursor: links?.nextCursor ?? null,
          invitations: page?.invitations ?? [], emailRevision: page?.siteRevision ?? 0,
        }));
      } catch (error: unknown) {
        if (!current) return;
        console.warn("[share] publication load failed", error instanceof Error ? error.name : "UnknownError");
        setView((previous) => ({ ...previous, loading: false, loadFailed: true, error: { operation: "load", message: "Sharing settings couldn’t load. Try again." } }));
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [appSlug, client, emailInvites, reload]);

  /** Runs one owner operation at a time and keeps errors allowlisted. */
  async function run(operation: ShareOperation, work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || busy.current) return false;
    busy.current = true;
    patch({ operation, error: null });
    try {
      await work(controller.signal);
      return true;
    } catch (error: unknown) {
      if (controller.signal.aborted || isAbortError(error)) return false;
      console.warn(`[share] ${operation} failed`, error instanceof Error ? error.name : "UnknownError");
      patch({ error: { operation, message: shareErrorMessage(error) } });
      return false;
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) patch({ operation: null });
    }
  }

  const titleFor = (site: SiteRecord | null) => site?.title ?? appName;

  /** Leave `private_email` before entering another mode (2691: revocation is permanent). */
  async function leaveEmail(signal: AbortSignal) {
    if (!view.emailActive || !emailInvites) return;
    await emailInvites.deactivate(appSlug, signal);
    patch({ emailActive: false, invitations: [], emailRevision: 0 });
  }

  async function ensurePrivateLinkSite(client: ShareSiteClient, signal: AbortSignal): Promise<SiteRecord> {
    const site = view.site;
    if (!site || site.status !== "published") {
      // The publish API requires the current manifest publishing config as a
      // freshness check (409 if it changed); it is not a human review step.
      const reviewedConfig = await client.getConfig(appSlug, signal);
      return client.deploy(appSlug, { title: titleFor(site), description: site?.description ?? "", slug: site?.slug ?? null, accessMode: "private_link", baseRevision: site?.revision ?? 0, reviewedConfig }, signal);
    }
    if (site.accessMode === "private_link") return site;
    return client.update(appSlug, { title: site.title, description: site.description, slug: site.slug, accessMode: "private_link", baseRevision: site.revision }, signal);
  }

  async function apply(request: ShareModeRequest, signal: AbortSignal) {
    if (!client) throw new Error("Sharing client unavailable");
    if (request.to === "private_link") {
      await leaveEmail(signal);
      // Sequential on purpose: the previous mode's access must end before the new one starts.
      // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- ordered access-mode transition, not independent work.
      const site = await ensurePrivateLinkSite(client, signal);
      const modeChanged = view.site?.accessMode !== "private_link" || view.site?.status !== "published";
      patch({ site, ...(modeChanged ? { links: [], linksNextCursor: null, freshLinks: {} } : {}) });
      const created = await client.createAccessLink(appSlug, { baseRevision: site.revision }, signal);
      setView((current) => ({
        ...current,
        links: [created.link, ...current.links.filter((link) => link.id !== created.link.id)],
        freshLinks: Object.fromEntries([[created.link.id, created.url] as const, ...Object.entries(current.freshLinks)].slice(0, MAX_FRESH_LINKS)),
      }));
      return;
    }
    if (request.to === "public") {
      await leaveEmail(signal);
      const site = view.site;
      const { metadata } = request;
      try {
        const next = site && site.status === "published"
          ? await client.update(appSlug, { ...metadata, accessMode: "public", baseRevision: site.revision }, signal)
          : await client.deploy(appSlug, { ...metadata, accessMode: "public", baseRevision: site?.revision ?? 0, reviewedConfig: await client.getConfig(appSlug, signal) }, signal);
        patch({ site: next, links: [], linksNextCursor: null, freshLinks: {}, slugConflict: null });
      } catch (error: unknown) {
        // The atomic alias claim lost: show the friendly path as taken.
        if (errorStatus(error) === 409 && metadata.slug && metadata.slug !== site?.slug) patch({ slugConflict: metadata.slug });
        throw error;
      }
      return;
    }
    if (!emailInvites) throw new Error("Email invitations unavailable");
    if (!view.emailActive) {
      const site = view.site;
      // TODO(2691): replace with client.update({ accessMode: "private_email", baseRevision }).
      // Until then the preview stops all current Matrix.page access by unpublishing,
      // so the confirm copy ("public link stops working") stays true.
      if (site && site.status === "published") patch({ site: await client.unpublish(appSlug, site.revision, signal), links: [], linksNextCursor: null, freshLinks: {} });
      await emailInvites.activate(appSlug, signal);
    }
    const page = await emailInvites.list(appSlug, signal);
    const result = await emailInvites.invite(appSlug, { emailAddresses: [request.email], baseRevision: page.siteRevision }, signal);
    // Re-list after the invite settles so the shown revision and people match the server.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- depends on the invite completing first.
    const after = await emailInvites.list(appSlug, signal);
    patch({ emailActive: true, invitations: after.invitations, emailRevision: after.siteRevision });
    const outcome = result.results[0]?.outcome;
    if (outcome === "invalid" || outcome === "policy_rejected") throw Object.assign(new Error("Invitation rejected"), { status: 400 });
  }

  function request(next: ShareModeRequest): Promise<boolean> {
    const target: PageModeTarget = next.to;
    if (needsModeSwitchConfirm(pageMode, target)) { patch({ pendingSwitch: next, error: null }); return Promise.resolve(false); }
    const operation: ShareOperation = next.to === "private_email" ? "invite" : next.to === "private_link" ? "link_create" : "publish";
    return run(operation, (signal) => apply(next, signal));
  }

  async function confirmSwitch(): Promise<boolean> {
    const pending = view.pendingSwitch;
    if (!pending) return false;
    const ok = await run("switch", (signal) => apply(pending, signal));
    if (ok) patch({ pendingSwitch: null });
    return ok;
  }

  return {
    ...view,
    pageMode,
    emailInvitesAvailable: emailInvites !== null,
    retry: () => { setView(initialView()); setReload((value) => value + 1); },
    request,
    confirmSwitch,
    cancelSwitch: () => patch({ pendingSwitch: null }),
    clearSlugConflict: () => patch({ slugConflict: null }),
    forgetFreshLink: (linkId: string) => setView((current) => {
      const { [linkId]: _removed, ...rest } = current.freshLinks;
      return { ...current, freshLinks: rest };
    }),
    revokeLink: (linkId: string) => run("link_revoke", async (signal) => {
      if (!client) return;
      await client.revokeAccessLink(appSlug, linkId, signal);
      setView((current) => {
        const { [linkId]: _removed, ...freshLinks } = current.freshLinks;
        return { ...current, links: current.links.filter((link) => link.id !== linkId), freshLinks };
      });
    }),
    loadMoreLinks: () => run("load", async (signal) => {
      if (!client || !view.linksNextCursor) return;
      const page = await client.accessLinks(appSlug, signal, view.linksNextCursor);
      setView((current) => ({ ...current, links: [...current.links, ...page.links.filter((link) => !current.links.some((existing) => existing.id === link.id))], linksNextCursor: page.nextCursor }));
    }),
    revokeInvite: (invitation: EmailInvitationSummary) => run("invite_change", async (signal) => {
      if (!emailInvites) return;
      await emailInvites.revoke(appSlug, invitation.id, { baseRevision: view.emailRevision, invitationRevision: invitation.revision }, signal);
      const page = await emailInvites.list(appSlug, signal);
      patch({ invitations: page.invitations, emailRevision: page.siteRevision });
    }),
    resendInvite: (invitation: EmailInvitationSummary) => run("invite_change", async (signal) => {
      if (!emailInvites) return;
      await emailInvites.resend(appSlug, invitation.id, { baseRevision: view.emailRevision, invitationRevision: invitation.revision }, signal);
      const page = await emailInvites.list(appSlug, signal);
      patch({ invitations: page.invitations, emailRevision: page.siteRevision });
    }),
    unpublish: () => run("unpublish", async (signal) => {
      const site = view.site;
      if (!client || !site || site.status !== "published") return;
      patch({ site: await client.unpublish(appSlug, site.revision, signal), links: [], linksNextCursor: null, freshLinks: {} });
    }),
  };
}

export type ShareController = ReturnType<typeof useShareController>;
