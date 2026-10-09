"use client";
import { useId, useState, type CSSProperties } from "react";
import { desktopPalette, desktopFonts } from "@matrix-os/brand/tokens";
import { SiteSlugSchema, type SitePublishing, type SiteRecord } from "@matrix-os/contracts";
import { Button, Input } from "@matrix-os/ui";
import type { SiteClient } from "../../lib/site-client";
import { useAppSite } from "./use-app-site";
import { formatSiteDate } from "./format-site-date";
import { SiteSubmissions } from "./SiteSubmissions";

export function AppSitePanel(props: { appSlug: string; client: SiteClient }) {
  return <AppSitePanelSession key={props.appSlug} {...props} />;
}
function AppSitePanelSession({ appSlug, client }: { appSlug: string; client: SiteClient }) {
  const state = useAppSite(appSlug, client);
  const formKey = `${state.loading ? "loading" : "ready"}:${state.site?.id ?? "private"}:${state.site?.revision ?? 0}`;
  return <AppSiteForm key={formKey} appSlug={appSlug} client={client} state={state} />;
}
function AppSiteForm({ appSlug, client, state }: { appSlug: string; client: SiteClient; state: ReturnType<typeof useAppSite> }) {
  const fieldId = useId();
  const { site, loading, pending, loadFailed, action } = state;
  const [title, setTitle] = useState(site?.title ?? appSlug);
  const [description, setDescription] = useState(site?.description ?? "");
  const [slug, setSlug] = useState(site?.slug ?? "");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [config, setConfig] = useState<SitePublishing | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [showSubmissions, setShowSubmissions] = useState(false);
  const invalidateReview = () => { setReviewed(false); setReviewOpen(false); setPreviewReady(false); setConfig(null); };
  const metadata = { title: title.trim(), description: description.trim(), slug: slug.trim() || null, ...(site ? { baseRevision: site.revision } : {}) };
  const invalid = !metadata.title || (metadata.slug !== null && !SiteSlugSchema.safeParse(metadata.slug).success);
  const published = site?.status === "published";
  const disabled = pending || loading || loadFailed;
  async function review() {
    invalidateReview();
    await action(signal => client.getConfig(appSlug, signal), declaration => {
      setConfig(declaration); setPreviewReady(true); setReviewOpen(true);
    });
  }
  return <section className="space-y-4" aria-label="App publishing" style={{
      "--matrix-fg": `var(--foreground, var(--text-primary, ${desktopPalette.forest}))`,
      "--matrix-card": `var(--background, var(--bg-surface, ${desktopPalette.paper}))`,
      "--matrix-input": "var(--border, var(--border-default))",
      "--matrix-border": "var(--border, var(--border-default))",
      "--matrix-primary": `var(--primary, var(--accent, ${desktopPalette.forest}))`,
      "--matrix-primary-fg": `var(--primary-foreground, var(--text-on-accent, ${desktopPalette.paper}))`,
      "--matrix-destructive": `var(--destructive, ${desktopPalette.danger})`,
      "--matrix-radius-md": "8px", "--matrix-font-sans": desktopFonts.sans,
      color: "var(--matrix-fg)",
    } as CSSProperties}>
    <p className="text-sm">Deploy this app to a public URL. Draft changes stay private until you publish an update.</p>
    <SitePublicationStatus state={state} />
    <SiteMetadataFields {...{ fieldId, disabled, title, description, slug, invalid, setTitle, setDescription, setSlug, invalidateReview }} />
    <SitePublicLinks {...{ site, disabled, action }} />
    <SiteDeploymentActions {...{ appSlug, client, state, disabled, invalid, reviewed, previewReady, config, metadata, review }} />
    {reviewOpen ? <SiteDeploymentReview {...{ config, reviewed, setReviewed }} /> : null}
    {site ? <>
      <SiteVersionHistory {...{ appSlug, client, state, disabled }} />
      <Button variant="secondary" disabled={disabled} onClick={() => { setShowSubmissions(true); void state.loadSubmissions(); }}>Visitor submissions</Button>
      {showSubmissions ? <SiteSubmissions appSlug={appSlug} client={client} state={state} /> : null}
      {published ? <SiteUnpublish {...{ appSlug, client, state, disabled }} /> : null}
    </> : null}
  </section>;
}

function SiteMetadataFields({ fieldId, disabled, title, description, slug, invalid, setTitle, setDescription, setSlug, invalidateReview }: {
  fieldId: string; disabled: boolean; title: string; description: string; slug: string; invalid: boolean;
  setTitle: (value: string) => void; setDescription: (value: string) => void; setSlug: (value: string) => void; invalidateReview: () => void;
}) { return <fieldset disabled={disabled} className="space-y-3">
      <Input label="Title" id={`${fieldId}-title`} maxLength={200} value={title} onChange={event => { setTitle(event.target.value); invalidateReview(); }} />
      <Input label="Description" id={`${fieldId}-description`} maxLength={1000} value={description} onChange={event => { setDescription(event.target.value); invalidateReview(); }} />
      <Input label="Friendly path (optional)" id={`${fieldId}-slug`} maxLength={63} placeholder="matrix-launch" value={slug} onChange={event => { setSlug(event.target.value); invalidateReview(); }} />
      <p className="text-xs">matrix.page/{slug || "your-permanent-id"}</p>
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
  const { site, action } = state;
  if (!site) return null;
  return <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Version history</summary><ul className="mt-3 space-y-2">
        {site.versions.map(version => <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span>{formatSiteDate(version.createdAt)} {version.id === site.activeVersion ? "· Current" : ""}</span>{version.id !== site.activeVersion ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void action(signal => client.rollback(appSlug, { versionId: version.id, baseRevision: site.revision }, signal), state.setSite, "Version restored.")}>Restore version {version.id.slice(0, 8)}</Button> : null}</li>)}
        {!site.versions.length ? <li>No published versions yet.</li> : null}
      </ul></details>;
}
function SiteUnpublish({ appSlug, client, state, disabled }: SiteSectionProps) {
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const { site, action } = state;
  if (!site) return null;
  return <div className="space-y-2 border-t pt-3"><Button variant="destructive" disabled={disabled} onClick={() => setConfirmUnpublish(true)}>Unpublish</Button>{confirmUnpublish ? <><p className="text-sm">This removes public access to the app and its forms. Saved submissions remain available.</p><div className="flex gap-2"><Button variant="destructive" disabled={disabled} onClick={async () => { const success = await action(signal => client.unpublish(appSlug, site.revision, signal), state.setSite, "App unpublished."); if (success) setConfirmUnpublish(false); }}>Confirm unpublish</Button><Button variant="secondary" disabled={disabled} onClick={() => setConfirmUnpublish(false)}>Cancel</Button></div></> : null}</div>;
}

function SitePublicationStatus({ state }: { state: ReturnType<typeof useAppSite> }) {
  const { site, loading, loadFailed, error, message } = state;
  const published = site?.status === "published";
  return <>{loading ? <p role="status">Loading publication…</p> : loadFailed ? null : <p role="status">{published ? "Your app is public." : "This app is private."}</p>}
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    {loadFailed ? <Button variant="secondary" onClick={state.refresh}>Retry</Button> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}</>;
}
function SitePublicLinks({ site, disabled, action }: { site: SiteRecord | null; disabled: boolean; action: ReturnType<typeof useAppSite>["action"] }) {
  if (!site) return null;
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
  metadata: { title: string; description: string; slug: string | null; baseRevision?: number }; review: () => Promise<void>;
}) {
  const { site, pending, action } = state;
  const published = site?.status === "published";
  return <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={disabled || invalid} onClick={() => void review()}>Review deployment</Button>
      <Button disabled={disabled || invalid || !reviewed || !previewReady} onClick={() => void action(signal => client.deploy(appSlug, { ...metadata, reviewedConfig: config! }, signal), state.setSite, "Published successfully.")}>{pending ? "Working…" : published ? "Publish update" : "Publish app"}</Button>
      {site ? <Button variant="secondary" disabled={disabled || invalid} onClick={() => void action(signal => client.update(appSlug, metadata, signal), state.setSite, "Publication settings saved.")}>Save URL and details</Button> : null}
    </div>;
}
