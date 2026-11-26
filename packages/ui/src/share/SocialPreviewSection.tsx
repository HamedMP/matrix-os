"use client";
import { useEffect, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { SiteRecord, SiteSocialSettings, SiteSocialUpdate } from "@matrix-os/contracts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../Select";
import { InlineError, ShareButton, ShareCollapsible, ShareCollapsibleContent, ShareCollapsibleTrigger, ShareInput, ShareTextarea, Spinner } from "./share-controls";
import { SHARE_DESCRIPTION_MAX, SHARE_TITLE_MAX } from "./share-model";
import { isAbortError, shareErrorMessage } from "./share-site-client";
import { cn } from "./share-cn";

/** The part of the shell `SiteClient` this section uses (Web and Electron both satisfy it). */
export interface ShareSocialClient {
  social(app: string, signal: AbortSignal): Promise<SiteSocialSettings>;
  updateSocial(app: string, value: SiteSocialUpdate, signal: AbortSignal): Promise<SiteSocialSettings>;
}

const NO_IMAGE = "__none__";
type Load = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; settings: SiteSocialSettings };
interface Draft { title: string; description: string; imagePath: string | null }

/** Link-preview editor for a live public app; hidden for link-gated or unpublished sites. */
export function SocialPreviewSection({ appSlug, client, site }: { appSlug: string; client: ShareSocialClient; site: SiteRecord }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  if (site.accessMode !== "public" || site.status !== "published") return null;
  return <ShareCollapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2.5 border-t border-[var(--share-border)] pt-3">
    <ShareCollapsibleTrigger aria-controls={contentId} className="-my-1 flex h-8 w-full items-center gap-2 bg-transparent p-0 text-left">
      <ChevronRight aria-hidden="true" className={cn("size-3.5 text-[var(--share-subtle-fg)] transition-transform", open && "rotate-90")} />
      <span className="text-[13px] font-medium">Link preview</span>
      <span className="text-xs text-[var(--share-subtle-fg)]">How shared links look</span>
    </ShareCollapsibleTrigger>
    <ShareCollapsibleContent id={contentId}>
      {open ? <LoadedEditor key={`${site.id}:${site.activeVersion}`} appSlug={appSlug} client={client} site={site} /> : null}
    </ShareCollapsibleContent>
  </ShareCollapsible>;
}

function LoadedEditor({ appSlug, client, site }: { appSlug: string; client: ShareSocialClient; site: SiteRecord }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    client.social(appSlug, controller.signal).then(
      (settings) => setLoad({ kind: "ready", settings }),
      (error: unknown) => {
        if (isAbortError(error)) return;
        console.warn("[share] link preview load failed", error instanceof Error ? "Error" : "UnknownError");
        setLoad({ kind: "failed" });
      },
    );
    return () => controller.abort();
  }, [appSlug, client]);
  if (load.kind === "loading") return <p role="status" className="m-0 flex items-center gap-1 text-xs text-[var(--share-subtle-fg)]"><Spinner className="size-3" />Loading…</p>;
  if (load.kind === "failed") return <InlineError>Link preview settings aren’t available yet.</InlineError>;
  return <SocialEditor appSlug={appSlug} client={client} site={site} initial={load.settings} />;
}

const toDraft = (settings: SiteSocialUpdate): Draft => ({ title: settings.title ?? "", description: settings.description ?? "", imagePath: settings.imagePath });
const toUpdate = (draft: Draft): SiteSocialUpdate => ({ title: draft.title.trim() || null, description: draft.description.trim() || null, imagePath: draft.imagePath });
type SaveResult = { ok: true } | { ok: false; message: string } | null;

function SocialEditor({ appSlug, client, site, initial }: { appSlug: string; client: ShareSocialClient; site: SiteRecord; initial: SiteSocialSettings }) {
  const titleId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const edit = (patch: Partial<Draft>) => { setDraft((current) => ({ ...current, ...patch })); setResult(null); };
  const update = toUpdate(draft);
  async function save() {
    setSaving(true);
    setResult(null);
    try {
      setDraft(toDraft(await client.updateSocial(appSlug, update, AbortSignal.timeout(15_000))));
      setResult({ ok: true });
    } catch (error: unknown) {
      console.warn("[share] link preview save failed", error instanceof Error ? "Error" : "UnknownError");
      setResult({ ok: false, message: shareErrorMessage(error, "Couldn’t save the link preview. Try again.") });
    } finally { setSaving(false); }
  }
  const imageAvailable = update.imagePath !== null && initial.imageOptions.includes(update.imagePath);
  // Disabled while saving so the server response cannot overwrite newer edits.
  return <fieldset disabled={saving} className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0 pl-[22px]">
    <PreviewCard title={update.title ?? site.title} description={update.description ?? site.description} imageUrl={imageAvailable ? previewImageUrl(site, update.imagePath) : null} />
    <div className="flex flex-col gap-1.5">
      <label htmlFor={titleId} className="text-xs font-medium">Preview title</label>
      <ShareInput id={titleId} value={draft.title} maxLength={SHARE_TITLE_MAX} placeholder={site.title} onChange={(event) => edit({ title: event.target.value })} />
    </div>
    <div className="flex flex-col gap-1.5">
      <label htmlFor={descriptionId} className="text-xs font-medium">Preview description</label>
      <ShareTextarea id={descriptionId} rows={2} value={draft.description} maxLength={SHARE_DESCRIPTION_MAX} placeholder={site.description || "Uses the app description"} onChange={(event) => edit({ description: event.target.value })} />
    </div>
    <ImagePicker options={initial.imageOptions} value={draft.imagePath} disabled={saving} onChange={(imagePath) => edit({ imagePath })} />
    <ShareButton variant="primary" size="sm" className="self-start" disabled={saving} onClick={() => void save()}>{saving ? <Spinner /> : null}Save preview</ShareButton>
    <SaveMessage result={result} />
  </fieldset>;
}

function previewImageUrl(site: SiteRecord, imagePath: string | null): string | null {
  return imagePath && site.activeVersion ? `https://matrix.page/${site.id}/assets/${site.activeVersion}/${imagePath}` : null;
}

function SaveMessage({ result }: { result: SaveResult }) {
  if (!result) return null;
  return result.ok ? <p role="status" className="m-0 text-xs font-medium text-[var(--share-success-fg)]">Preview saved.</p> : <InlineError>{result.message}</InlineError>;
}

/**
 * A saved image a redeploy removed stays selectable (labelled), so the owner can
 * keep it for a later build or clear it; saving other fields never fails on it.
 */
function ImagePicker({ options, value, disabled, onChange }: { options: string[]; value: string | null; disabled: boolean; onChange: (value: string | null) => void }) {
  const imageId = useId();
  const stale = value !== null && !options.includes(value) ? value : null;
  return <div className="flex flex-col gap-1.5">
    <label htmlFor={imageId} className="text-xs font-medium">Preview image</label>
    {options.length || stale ? <Select value={value ?? NO_IMAGE} disabled={disabled} onValueChange={(next) => onChange(next === NO_IMAGE ? null : next)}>
      <SelectTrigger id={imageId} size="sm" className="w-full border-[var(--share-input)] bg-[var(--share-bg)] text-[13px] text-[var(--share-fg)]"><SelectValue /></SelectTrigger>
      <SelectContent position="popper" sideOffset={4} className="matrix-share w-[var(--radix-select-trigger-width)] rounded-lg">
        <SelectItem value={NO_IMAGE}>No image</SelectItem>
        {stale ? <SelectItem value={stale}>{stale} (not in the current build)</SelectItem> : null}
        {options.map((path) => <SelectItem key={path} value={path}>{path}</SelectItem>)}
      </SelectContent>
    </Select> : null}
    {stale ? <p className="m-0 text-xs leading-4 text-[var(--share-subtle-fg)]">This image isn’t in the latest build, so links show no image until you restore the file or pick another.</p> : null}
    {!options.length && !stale ? <p id={imageId} className="m-0 text-xs leading-4 text-[var(--share-subtle-fg)]">To show an image, add a PNG, JPEG or WebP file to the app’s build and publish the latest version.</p> : null}
  </div>;
}

function PreviewCard({ title, description, imageUrl }: { title: string; description: string; imageUrl: string | null }) {
  return <figure aria-label="Link preview" className="m-0 overflow-hidden rounded-lg border border-[var(--share-border)] bg-[var(--share-panel)]">
    {imageUrl ? <PreviewImage key={imageUrl} url={imageUrl} /> : null}
    <figcaption className="flex flex-col gap-0.5 px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-[var(--share-subtle-fg)]">matrix.page</span>
      <span className="truncate text-[13px] font-semibold">{title}</span>
      {description ? <span className="line-clamp-2 text-xs text-[var(--share-muted-fg)]">{description}</span> : null}
    </figcaption>
  </figure>;
}

/** Keyed by URL so a failed load resets when the owner picks another image. */
function PreviewImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="block aspect-[1.91/1] w-full bg-[var(--share-muted)] object-cover" />;
}
