"use client";
import { useId, useState, type CSSProperties } from "react";
import { desktopPalette, desktopFonts } from "@matrix-os/brand/tokens";
import { SiteSlugSchema, type SitePublishing, type SiteRecord } from "@matrix-os/contracts";
import { Button, Input } from "@matrix-os/ui";
import type { SiteClient } from "../../lib/site-client";
import { useAppSite } from "./use-app-site";
import { formatSiteDate } from "./format-site-date";
import { SiteSubmissions } from "./SiteSubmissions";
import { SiteAccessLinks } from "./SiteAccessLinks";

export function AppSitePanel(props: { appSlug: string; client: SiteClient; variant?: "default" | "share" }) {
  return <AppSitePanelSession key={props.appSlug} {...props} />;
}
function AppSitePanelSession({ appSlug, client, variant = "default" }: { appSlug: string; client: SiteClient; variant?: "default" | "share" }) {
  const state = useAppSite(appSlug, client);
  const formKey = `${state.loading ? "loading" : "ready"}:${state.metadataEpoch}`;
  return <AppSiteForm key={formKey} appSlug={appSlug} client={client} state={state} variant={variant} />;
}
// react-doctor-disable-next-line react-doctor/no-high-complexity-react-function -- The pre-existing form coordinates one publishing draft and delegates each access, version, submission, and deployment section below; this change only adds a visual variant without altering that state machine.
function AppSiteForm({ appSlug, client, state, variant }: { appSlug: string; client: SiteClient; state: ReturnType<typeof useAppSite>; variant: "default" | "share" }) {
  const fieldId = useId();
  const { site, loading, pending, loadFailed, action } = state;
  const [title, setTitle] = useState(site?.title ?? appSlug);
  const [description, setDescription] = useState(site?.description ?? "");
  const [slug, setSlug] = useState(site?.slug ?? "");
  const [accessMode, setAccessMode] = useState<"public" | "private_link">(site?.accessMode ?? "public");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [config, setConfig] = useState<SitePublishing | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const invalidateReview = () => { setReviewed(false); setReviewOpen(false); setPreviewReady(false); setConfig(null); };
  const metadata = { title: title.trim(), description: description.trim(), slug: slug.trim() || null, accessMode, baseRevision: site?.revision ?? 0 };
  const invalid = !metadata.title || (metadata.slug !== null && !SiteSlugSchema.safeParse(metadata.slug).success);
  const disabled = pending || loading || loadFailed;
  async function review() {
    if (reviewOpen) { invalidateReview(); return; }
    invalidateReview();
    await action(signal => client.getConfig(appSlug, signal), declaration => {
      setConfig(declaration); setPreviewReady(true); setReviewOpen(true);
    });
  }
  const share = variant === "share";
  return <section className={share ? "space-y-3 text-[13px] [&_div.border]:border-[#323238] [&_fieldset]:rounded-lg [&_fieldset]:border [&_fieldset]:border-[#323238] [&_fieldset]:bg-[#171717] [&_fieldset]:p-3 [&_details]:border-[#323238] [&_details]:bg-[#171717] [&_li.border]:border-[#323238] [&_pre]:border-[#323238] [&_select]:border-[#3f3f46] [&_select]:bg-[#171717] [&_select]:text-[#f4f4f5]" : "space-y-4"} aria-label="App publishing" style={{
      "--matrix-fg": share ? "#f4f4f5" : `var(--foreground, var(--text-primary, ${desktopPalette.forest}))`,
      "--matrix-card": share ? "#171717" : `var(--background, var(--bg-surface, ${desktopPalette.paper}))`,
      "--matrix-input": share ? "#3f3f46" : "var(--border, var(--border-default))",
      "--matrix-border": share ? "#3f3f46" : "var(--border, var(--border-default))",
      "--matrix-primary": share ? "#2563eb" : `var(--primary, var(--accent, ${desktopPalette.forest}))`,
      "--matrix-primary-fg": share ? "#ffffff" : `var(--primary-foreground, var(--text-on-accent, ${desktopPalette.paper}))`,
      "--matrix-destructive": share ? "#ef4444" : `var(--destructive, ${desktopPalette.danger})`,
      "--muted": share ? "#27272a" : undefined,
      "--muted-foreground": share ? "#a1a1aa" : undefined,
      "--bg-surface": share ? "#171717" : undefined,
      "--border-default": share ? "#323238" : undefined,
      "--text-primary": share ? "#f4f4f5" : undefined,
      "--text-secondary": share ? "#a1a1aa" : undefined,
      "--matrix-radius-md": "8px", "--matrix-font-sans": desktopFonts.sans,
      color: "var(--matrix-fg)",
    } as CSSProperties}>
    {share ? <ShareInviteSection {...{ appSlug, client, state, disabled }} /> : null}
    <p className="text-sm">Publish this app on Matrix.page. Choose public access or create one-time private links.</p>
    <SitePublicationStatus state={state} onRefreshPublication={() => { invalidateReview(); void state.reloadPublication(); }} />
    <SiteMetadataFields {...{ fieldId, disabled, title, description, slug, accessMode, invalid, setTitle, setDescription, setSlug, setAccessMode, invalidateReview }} />
    <SitePublicLinks {...{ site, disabled, action }} />
    <SiteDeploymentActions {...{ appSlug, client, state, disabled, invalid, reviewed, previewReady, config, metadata, review }} />
    {reviewOpen ? <SiteDeploymentReview {...{ config, reviewed, setReviewed }} /> : null}
    <SitePublicationManagement {...{ appSlug, client, state, disabled }} showAccessLinks={!share} />
  </section>;
}

function ShareInviteSection({ appSlug, client, state, disabled }: SiteSectionProps) {
  return <section aria-label="Invite" className="space-y-3 rounded-lg border border-[#323238] bg-[#171717] p-3">
    <div className="space-y-1">
      <h3 className="text-base font-semibold">Invite</h3>
      <p className="text-xs leading-5 text-[#a1a1aa]">Invite collaborators to use this app. Email invitations are not available yet.</p>
    </div>
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
      <input aria-label="Invite by email" disabled placeholder="Invite by email" className="h-9 min-w-0 rounded-md border border-[#3f3f46] bg-[#111113] px-3 text-sm text-[#71717a] disabled:cursor-not-allowed" />
      <Button disabled size="sm">Invite</Button>
    </div>
    <div className="flex items-center gap-3 py-1">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#c2410c] text-sm font-semibold text-white">Y</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">You</p>
        <p className="text-xs text-[#a1a1aa]">App owner</p>
      </div>
      <span className="text-sm font-medium text-[#d4d4d8]">Owner</span>
    </div>
    <SiteAccessLinks appSlug={appSlug} client={client} site={state.site} state={state} disabled={disabled || state.conflict} variant="invite" />
  </section>;
}

function SiteMetadataFields({ fieldId, disabled, title, description, slug, accessMode, invalid, setTitle, setDescription, setSlug, setAccessMode, invalidateReview }: {
  fieldId: string; disabled: boolean; title: string; description: string; slug: string; accessMode: "public" | "private_link"; invalid: boolean;
  setTitle: (value: string) => void; setDescription: (value: string) => void; setSlug: (value: string) => void; setAccessMode: (value: "public" | "private_link") => void; invalidateReview: () => void;
}) { return <fieldset disabled={disabled} className="space-y-3">
      <Input label="Title" id={`${fieldId}-title`} maxLength={200} value={title} onChange={event => { setTitle(event.target.value); invalidateReview(); }} />
      <Input label="Description" id={`${fieldId}-description`} maxLength={1000} value={description} onChange={event => { setDescription(event.target.value); invalidateReview(); }} />
      <Input label="Friendly path (optional)" id={`${fieldId}-slug`} maxLength={63} placeholder="matrix-launch" value={slug} onChange={event => { setSlug(event.target.value); invalidateReview(); }} />
      <p className="text-xs">matrix.page/{slug || "your-permanent-id"}</p>
      <label className="block space-y-1 text-sm" htmlFor={`${fieldId}-access`}><span className="font-medium">Access</span><select id={`${fieldId}-access`} className="block w-full rounded border bg-transparent p-2" value={accessMode} onChange={event => { setAccessMode(event.target.value as "public" | "private_link"); invalidateReview(); }}><option value="public">Public</option><option value="private_link">Private — one-time links</option></select></label>
      {invalid && slug ? <p className="text-xs">Use 2–63 lowercase letters, numbers, or hyphens, starting with a letter. Some paths are reserved.</p> : null}
    </fieldset>; }
function SiteDeploymentReview({ config, reviewed, setReviewed }: { config: SitePublishing | null; reviewed: boolean; setReviewed: (value: boolean) => void }) {
  return <div className="ph-no-capture space-y-3 rounded-lg border p-3" aria-label="Deployment preview">
      <p className="text-sm">Only declared public data and forms are available to visitors. Private app data and Matrix tools stay private.</p>
      <p className="text-xs">Review the app in its window before deploying. The app preview uses your private runtime; public visitors receive only the capabilities shown below.</p>
      {config ? <div className="space-y-2 text-xs"><p className="font-medium">Public data</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border p-2">{JSON.stringify(config.data, null, 2)}</pre><p className="font-medium">Public forms</p>{config.forms.length ? <ul className="space-y-2">{config.forms.map(form => <li key={form.id}>{form.title} ({form.id})<ul>{Object.entries(form.fields).map(([name, field]) => <li key={name}>{name} · {field.type}{field.required ? " · Required" : ""}</li>)}</ul></li>)}</ul> : <p>No public forms declared.</p>}</div> : null}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed this deployment</label>
    </div>;
}
type SiteSectionProps = { appSlug: string; client: SiteClient; state: ReturnType<typeof useAppSite>; disabled: boolean };
function SiteVersionHistory({ appSlug, client, state, disabled }: SiteSectionProps) {
  const { site, mutate } = state;
  if (!site) return null;
  return <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Version history</summary><ul className="mt-3 space-y-2">
        {site.versions.map(version => <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{formatSiteDate(version.createdAt)} {version.id === site.activeVersion ? "· Current" : ""}</span>{version.id !== site.activeVersion ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void mutate(signal => client.rollback(appSlug, { versionId: version.id, baseRevision: site.revision }, signal), state.setSite, "Version restored.")}>Restore version {version.id.slice(0, 8)}</Button> : null}</li>)}
        {!site.versions.length ? <li>No published versions yet.</li> : null}
      </ul></details>;
}
function SiteUnpublish({ appSlug, client, state, disabled }: SiteSectionProps) {
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const { site, mutate } = state;
  if (!site) return null;
  return <div className="space-y-2 border-t pt-3"><Button variant="destructive" disabled={disabled} onClick={() => setConfirmUnpublish(true)}>Unpublish</Button>{confirmUnpublish ? <><p className="text-sm">This removes public access to the app and its forms. Saved submissions remain available.</p><div className="flex gap-2"><Button variant="destructive" disabled={disabled} onClick={async () => { const success = await mutate(signal => client.unpublish(appSlug, site.revision, signal), state.setSite, "App unpublished."); if (success) setConfirmUnpublish(false); }}>Confirm unpublish</Button><Button variant="secondary" disabled={disabled} onClick={() => setConfirmUnpublish(false)}>Cancel</Button></div></> : null}</div>;
}

function SitePublicationStatus({ state, onRefreshPublication }: { state: ReturnType<typeof useAppSite>; onRefreshPublication: () => void }) {
  const { site, loading, loadFailed, error, message } = state;
  const published = site?.status === "published";
  return <>{loading ? <p role="status">Loading publication…</p> : loadFailed ? null : <p role="status">{published ? site?.accessMode === "private_link" ? "Your app uses one-time links." : "Your app is public." : "This app is private."}</p>}
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    {loadFailed ? <Button variant="secondary" onClick={state.refresh}>Retry</Button> : null}
    {state.conflict ? <Button variant="secondary" disabled={state.pending || loading} onClick={onRefreshPublication}>Refresh publication</Button> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}</>;
}
function SitePublicLinks({ site, disabled, action }: { site: SiteRecord | null; disabled: boolean; action: ReturnType<typeof useAppSite>["action"] }) {
  if (!site || site.accessMode === "private_link") return null;
  const permanentUrl = `https://matrix.page/${site.id}`;
  const friendlyUrl = site.slug ? `https://matrix.page/${site.slug}` : null;
  return <div className="space-y-2 rounded-lg border p-3">
      <p className="text-xs">Permanent URL</p>
      <p className="break-all text-sm">{permanentUrl}</p>
      <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void action(async () => navigator.clipboard.writeText(permanentUrl), () => {}, "Permanent URL copied.")}>Copy permanent URL</Button>
      {friendlyUrl ? <><p className="break-all text-sm">{friendlyUrl}</p><Button size="sm" variant="secondary" disabled={disabled} onClick={() => void action(async () => navigator.clipboard.writeText(friendlyUrl), () => {}, "Friendly URL copied.")}>Copy friendly URL</Button></> : null}
    </div>;
}
function SiteDeploymentActions({ appSlug, client, state, disabled, invalid, reviewed, previewReady, config, metadata, review }: SiteSectionProps & {
  invalid: boolean; reviewed: boolean; previewReady: boolean; config: SitePublishing | null;
  metadata: { title: string; description: string; slug: string | null; accessMode: "public" | "private_link"; baseRevision?: number }; review: () => Promise<void>;
}) {
  const { site, pending, mutate } = state;
  const published = site?.status === "published";
  const mutationDisabled = disabled || state.conflict;
  return <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={disabled || invalid} onClick={() => void review()}>Review deployment</Button>
      <Button disabled={mutationDisabled || invalid || !reviewed || !previewReady} onClick={() => void mutate(signal => client.deploy(appSlug, { ...metadata, reviewedConfig: config! }, signal), state.setSite, "Published successfully.")}>{pending ? "Working…" : published ? "Publish update" : "Publish app"}</Button>
      {site ? <Button variant="secondary" disabled={mutationDisabled || invalid} onClick={() => void mutate(signal => client.update(appSlug, metadata, signal), state.setSite, "Publication settings saved.")}>Save URL and details</Button> : null}
    </div>;
}

function SitePublicationManagement({ appSlug, client, state, disabled, showAccessLinks }: SiteSectionProps & { showAccessLinks: boolean }) {
  const submissionsId = useId();
  const [showSubmissions, setShowSubmissions] = useState(false);
  if (!state.site) return null;
  const published = state.site.status === "published";
  return <>
      {showAccessLinks ? <SiteAccessLinks appSlug={appSlug} client={client} site={state.site} state={state} disabled={disabled || state.conflict} /> : null}
      <SiteVersionHistory {...{ appSlug, client, state }} disabled={disabled || state.conflict} />
      <Button variant="secondary" disabled={disabled} aria-expanded={showSubmissions} aria-controls={submissionsId} onClick={() => { setShowSubmissions(!showSubmissions); if (!showSubmissions) void state.loadSubmissions(); }}>Visitor submissions</Button>
      {showSubmissions ? <SiteSubmissions id={submissionsId} appSlug={appSlug} client={client} state={state} /> : null}
      {published ? <SiteUnpublish {...{ appSlug, client, state }} disabled={disabled || state.conflict} /> : null}
</>;
}
