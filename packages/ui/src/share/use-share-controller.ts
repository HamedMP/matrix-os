import { useEffect, useRef, useState, type SetStateAction } from "react";
import type { SiteRecord } from "@matrix-os/contracts";
import type { EmailInvitationAdapter, EmailInvitationPage, EmailInvitationSummary } from "./email-invitations";
import { needsModeSwitchConfirm, pageModeOf, type PageMode, type PageModeTarget } from "./share-model";
import { errorStatus, isAbortError, shareErrorMessage, type ShareSiteClient } from "./share-site-client";

export interface PublicMetadata { title: string; description: string; slug: string | null }

/** What the owner asked for. Applied immediately or after the mode-switch confirm. */
export type ShareModeRequest =
  | { to: "private_email"; email: string }
  | { to: "public"; metadata: PublicMetadata };

export type ShareOperation = "load" | "invite" | "invite_change" | "publish" | "update" | "save" | "unpublish" | "stop" | "switch";

interface ShareView {
  site: SiteRecord | null;
  loading: boolean;
  loadFailed: boolean;
  operation: ShareOperation | null;
  error: { operation: ShareOperation; message: string } | null;
  invitations: EmailInvitationSummary[];
  emailRevision: number;
  emailActive: boolean;
  emailAvailable: boolean;
  invitationsNextCursor: string | null;
  invitationsPaged: boolean;
  inviteOutcome: "queued" | "existing" | null;
  pendingSwitch: ShareModeRequest | null;
  /** Friendly path rejected by the platform's atomic alias claim. */
  slugConflict: string | null;
}

const initialView = (): ShareView => ({
  site: null, loading: true, loadFailed: false, operation: null, error: null,
  invitations: [], emailRevision: 0, emailActive: false, emailAvailable: false, invitationsNextCursor: null, invitationsPaged: false, inviteOutcome: null,
  pendingSwitch: null, slugConflict: null,
});

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
  const mutationVersion = useRef(0);
  const newestResetPending = useRef(false);
  const identityRef = useRef({ appSlug, client, emailInvites });
  if (identityRef.current.appSlug !== appSlug || identityRef.current.client !== client || identityRef.current.emailInvites !== emailInvites) {
    identityRef.current = { appSlug, client, emailInvites };
  }
  const identity = identityRef.current;
  // Account/runtime changes must discard every late mutation result too.
  const setCurrentView = (value: SetStateAction<ShareView>) => {
    setView((current) => identityRef.current !== identity ? current : typeof value === "function" ? value(current) : value);
  };
  const patch = (value: Partial<ShareView>) => setCurrentView((current) => ({ ...current, ...value }));
  const pageMode: PageMode = pageModeOf(view.site, view.emailActive);

  // Owner actions get their own lifecycle: a silent re-read must never abort a
  // running mutation (it would leave `operation` set and the buttons disabled).
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller; busy.current = false; newestResetPending.current = false;
    return () => { controller.abort(); };
  }, [appSlug, client, emailInvites]);

  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    const signal = controller.signal;
    let current = true;
    const version = mutationVersion.current;
    void (async () => {
      try {
        const [initialSite, emailAvailable] = await Promise.all([
          client.get(appSlug, signal),
          emailInvites?.kind === "live" ? emailInvites.available(appSlug, signal).catch((error: unknown) => {
            console.warn("[share] invitation readiness unavailable", error instanceof Error ? error.name : "UnknownError");
            return false;
          }) : Promise.resolve(emailInvites?.kind === "preview"),
        ]);
        let site = initialSite;
        // Read once more after a concurrent change; never attach a newer token
        // to metadata read at an older revision. Continued churn fails closed.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const emailActive = emailInvites?.kind === "preview" ? emailInvites.active(appSlug)
            : site?.status === "published" && site.accessMode === "private_email";
          // react-doctor-disable-next-line react-doctor/async-defer-await -- cancellation and revision guards must run after the in-flight read settles.
          const page = emailActive && emailAvailable && emailInvites ? await emailInvites.list(appSlug, signal) : null;
          if (!current || version !== mutationVersion.current || busy.current) return;
          if (emailInvites?.kind === "live" && page && page.siteRevision !== site?.revision) {
            if (attempt === 1) throw Object.assign(new Error("Publication changed during read"), { status: 409 });
            site = await client.get(appSlug, signal);
            continue;
          }
          setCurrentView((previous) => ({
            ...previous, site, loading: false, loadFailed: false, emailActive, emailAvailable,
            invitations: page?.invitations ?? [], emailRevision: page?.siteRevision ?? site?.revision ?? 0,
            invitationsNextCursor: page?.nextCursor ?? null, invitationsPaged: false,
          }));
          return;
        }
      } catch (error: unknown) {
        if (!current || version !== mutationVersion.current || busy.current) return;
        console.warn("[share] publication load failed", error instanceof Error ? error.name : "UnknownError");
        setCurrentView((previous) => ({ ...previous, loading: false, loadFailed: true, error: { operation: "load", message: "Couldn’t load." } }));
      } finally {
        if (current && identityRef.current === identity && newestResetPending.current) {
          newestResetPending.current = false;
          patch({ operation: null });
        }
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [appSlug, client, emailInvites, reload]);

  /**
   * Runs one owner operation at a time and keeps errors allowlisted. Nothing
   * runs until the current publication is known: replacing an access mode
   * needs a successful read first.
   */
  async function run(operation: ShareOperation, work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || busy.current || newestResetPending.current || view.loading || view.loadFailed) return false;
    busy.current = true;
    mutationVersion.current += 1;
    patch({ operation, error: null, ...(operation === "invite" || operation === "switch" ? { inviteOutcome: null } : {}) });
    try {
      await work(controller.signal);
      return !controller.signal.aborted && identityRef.current === identity;
    } catch (error: unknown) {
      if (controller.signal.aborted || isAbortError(error)) return false;
      console.warn(`[share] ${operation} failed`, error instanceof Error ? error.name : "UnknownError");
      patch({ error: { operation, message: shareErrorMessage(error) } });
      // Another window or device changed the publication: re-read it so the
      // next attempt carries the current revision.
      if (errorStatus(error) === 409 && identityRef.current === identity) setReload((value) => value + 1);
      return false;
    } finally {
      if (identityRef.current === identity && lifecycle.current === controller) {
        busy.current = false;
        if (!controller.signal.aborted) {
          patch({ operation: null });
          // Resolve partial successes/failures and any read invalidated by this mutation.
          if (operation !== "load") setReload((value) => value + 1);
        }
      }
    }
  }

  const titleFor = (site: SiteRecord | null) => site?.title ?? appName;

  /** Leave `private_email` before entering another mode (2691: revocation is permanent). */
  async function leaveEmail(signal: AbortSignal) {
    if (!view.emailActive || emailInvites?.kind !== "preview") return;
    await emailInvites.deactivate(appSlug, signal);
    patch({ emailActive: false, invitations: [], emailRevision: 0, invitationsNextCursor: null });
  }

  async function apply(request: ShareModeRequest, signal: AbortSignal) {
    if (!client) throw new Error("Sharing client unavailable");
    if (request.to === "public") {
      await leaveEmail(signal);
      const site = view.site;
      const { metadata } = request;
      try {
        const next = site && site.status === "published"
          ? await client.update(appSlug, { ...metadata, accessMode: "public", baseRevision: site.revision }, signal)
          : await client.deploy(appSlug, { ...metadata, accessMode: "public", baseRevision: site?.revision ?? 0, reviewedConfig: await client.getConfig(appSlug, signal) }, signal);
        patch({ site: next, emailActive: false, invitations: [], invitationsNextCursor: null, slugConflict: null });
      } catch (error: unknown) {
        // The atomic alias claim lost: show the friendly path as taken.
        if (errorStatus(error) === 409 && metadata.slug && metadata.slug !== site?.slug) patch({ slugConflict: metadata.slug });
        throw error;
      }
      return;
    }
    if (!emailInvites || !view.emailAvailable) throw new Error("Email invitations unavailable");
    let emailSiteRevision = view.site?.revision;
    if (emailInvites.kind === "preview") {
      if (!view.emailActive) {
        const site = view.site;
        // The preview stops all current Matrix.page access by unpublishing, so
        // the confirm copy ("public link stops working") stays true.
        if (site?.status === "published") patch({ site: await client.unpublish(appSlug, site.revision, signal) });
        await emailInvites.activate(appSlug, signal);
      }
    } else {
      const current = view.site;
      const site = current?.status === "published"
        ? current.accessMode === "private_email" ? current
          : await client.update(appSlug, { title: current.title, description: current.description, slug: current.slug, accessMode: "private_email", baseRevision: current.revision }, signal)
        : await client.deploy(appSlug, { title: titleFor(current), description: current?.description ?? "", slug: current?.slug ?? null, accessMode: "private_email", baseRevision: current?.revision ?? 0, reviewedConfig: await client.getConfig(appSlug, signal) }, signal);
      emailSiteRevision = site.revision;
      // The backend transaction revokes the old mode (including legacy one-time links) and activates the new one.
      patch({ site, emailActive: true, emailRevision: site.revision });
    }
    const page = await emailInvites.list(appSlug, signal);
    if (emailInvites.kind === "live" && page.siteRevision !== emailSiteRevision) {
      throw Object.assign(new Error("Publication changed before invite"), { status: 409 });
    }
    const result = await emailInvites.invite(appSlug, { emailAddresses: [request.email], baseRevision: page.siteRevision }, signal);
    syncEmailRevision(result.siteRevision);
    const outcome = result.results[0]?.outcome;
    patch({ emailActive: true, inviteOutcome: outcome === "queued" || outcome === "existing" ? outcome : null });
    const after = await emailInvites.list(appSlug, signal);
    syncEmailPage(after, result.siteRevision);
    if (outcome !== "queued" && outcome !== "existing") throw Object.assign(new Error("Invitation rejected"), { status: 400 });
  }

  function syncEmailRevision(revision: number) {
    setCurrentView((current) => ({ ...current, emailRevision: revision,
      site: current.site ? { ...current.site, revision } : null }));
  }

  function syncEmailPage(page: EmailInvitationPage, expectedRevision: number) {
    if (emailInvites?.kind === "live" && page.siteRevision !== expectedRevision) {
      throw Object.assign(new Error("Publication changed after invitation mutation"), { status: 409 });
    }
    setCurrentView((current) => ({ ...current, invitations: page.invitations,
      invitationsNextCursor: page.nextCursor ?? null, invitationsPaged: false, emailRevision: page.siteRevision }));
  }

  function request(next: ShareModeRequest): Promise<boolean> {
    if (view.loading || view.loadFailed || (next.to === "private_email" && !view.emailAvailable)) return Promise.resolve(false);
    const target: PageModeTarget = next.to;
    if (needsModeSwitchConfirm(pageMode, target)) { patch({ pendingSwitch: next, error: null }); return Promise.resolve(false); }
    const operation: ShareOperation = next.to === "private_email" ? "invite" : "publish";
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
    /** The preview fake is always on; a live adapter waits for the server capability. */
    emailInvitesAvailable: view.emailAvailable || emailInvites?.kind === "preview",
    retry: () => { setCurrentView(initialView()); setReload((value) => value + 1); },
    /** Silent re-read (e.g. when the popover opens) so mutations use the current revision. */
    refresh: () => { if (!busy.current) setReload((value) => value + 1); },
    /** Redeploys the app's current files, keeping access mode and details. */
    publishUpdate: () => run("update", async (signal) => {
      const site = view.site;
      if (!client || !site || site.status !== "published") return;
      const reviewedConfig = await client.getConfig(appSlug, signal);
      patch({ site: await client.deploy(appSlug, { title: site.title, description: site.description, slug: site.slug, accessMode: site.accessMode, baseRevision: site.revision, reviewedConfig }, signal) });
    }),
    /** Saves friendly path, title and description of a published app. */
    saveDetails: (metadata: PublicMetadata) => run("save", async (signal) => {
      const site = view.site;
      if (!client || !site || site.status !== "published") return;
      try {
        patch({ site: await client.update(appSlug, { ...metadata, accessMode: site.accessMode, baseRevision: site.revision }, signal), slugConflict: null });
      } catch (error: unknown) {
        if (errorStatus(error) === 409 && metadata.slug && metadata.slug !== site.slug) patch({ slugConflict: metadata.slug });
        throw error;
      }
    }),
    /** Ends all private access: email invites and grants, or a legacy one-time-link site and its viewer sessions. */
    stopSharing: () => run("stop", async (signal) => {
      await leaveEmail(signal);
      const site = view.site;
      if (client && site && site.status === "published") {
        patch({ site: await client.unpublish(appSlug, site.revision, signal), emailActive: false, invitations: [], invitationsNextCursor: null });
      }
    }),
    request,
    confirmSwitch,
    cancelSwitch: () => patch({ pendingSwitch: null }),
    clearSlugConflict: () => patch({ slugConflict: null }),
    loadMoreInvitations: () => run("load", async (signal) => {
      if (!emailInvites || !view.emailAvailable || !view.invitationsNextCursor) return;
      const page = await emailInvites.list(appSlug, signal, view.invitationsNextCursor);
      // A changed list invalidates the cursor; refresh instead of mixing revisions.
      if (page.siteRevision !== view.emailRevision) throw Object.assign(new Error("Invitation list changed"), { status: 409 });
      setCurrentView((current) => ({ ...current,
        invitations: [...current.invitations, ...page.invitations.filter((item) => !current.invitations.some((existing) => existing.id === item.id))].slice(-100),
        invitationsNextCursor: page.nextCursor ?? null, invitationsPaged: true }));
    }),
    showNewestInvitations: () => {
      if (busy.current || newestResetPending.current) return;
      newestResetPending.current = true;
      patch({ operation: "load" });
      setReload((value) => value + 1);
    },
    revokeInvite: (invitation: EmailInvitationSummary) => run("invite_change", async (signal) => {
      if (!emailInvites || !view.emailAvailable) return;
      const result = await emailInvites.revoke(appSlug, invitation.id, { baseRevision: view.emailRevision, invitationRevision: invitation.revision }, signal);
      syncEmailRevision(result.siteRevision);
      syncEmailPage(await emailInvites.list(appSlug, signal), result.siteRevision);
    }),
    resendInvite: (invitation: EmailInvitationSummary) => run("invite_change", async (signal) => {
      if (!emailInvites || !view.emailAvailable) return;
      const result = await emailInvites.resend(appSlug, invitation.id, { baseRevision: view.emailRevision, invitationRevision: invitation.revision }, signal);
      syncEmailRevision(result.siteRevision);
      syncEmailPage(await emailInvites.list(appSlug, signal), result.siteRevision);
    }),
    unpublish: () => run("unpublish", async (signal) => {
      const site = view.site;
      if (!client || !site || site.status !== "published") return;
      patch({ site: await client.unpublish(appSlug, site.revision, signal), emailActive: false, invitations: [], invitationsNextCursor: null });
    }),
  };
}

export type ShareController = ReturnType<typeof useShareController>;
