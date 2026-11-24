"use client";
import { useId, useState, type ReactNode } from "react";
import { Check, ChevronRight, Globe, Pencil, RefreshCw } from "lucide-react";
import { SHARE_DESCRIPTION_MAX, SHARE_TITLE_MAX, metadataSummary, normalizeSlugInput, slugBlocksPublish, type SlugState } from "./share-model";
import { BusyStatus, InlineError, ShareButton, ShareCollapsible, ShareCollapsibleContent, ShareCollapsibleTrigger, ShareInput, ShareTextarea, Spinner } from "./share-controls";
import { cn } from "./share-cn";
import type { ShareController } from "./use-share-controller";
import { useCopy } from "./use-copy";

/** The description counter appears only near the limit. */
const SHARE_DESCRIPTION_COUNTER_FROM = 900;

export interface PublicDraft {
  slug: string;
  title: string;
  description: string;
  metaOpen: boolean;
}

export function PublicTab({ share, draft, setDraft, slugState, onPublish, onSaveDetails, submissions }: {
  share: ShareController; draft: PublicDraft; setDraft: (patch: Partial<PublicDraft>) => void; slugState: SlugState; onPublish: () => void;
  onSaveDetails: () => void;
  /** Host-supplied visitor submissions view; only passed for apps with public forms. */
  submissions?: ReactNode;
}) {
  if (share.pageMode === "public" && share.site) {
    return <LivePublic share={share} draft={draft} setDraft={setDraft} slugState={slugState} onSaveDetails={onSaveDetails} submissions={submissions} />;
  }
  const blocked = slugBlocksPublish(slugState);
  const publishing = share.operation === "publish";
  return <div className="flex flex-col gap-3.5">
    <SlugField share={share} draft={draft} setDraft={setDraft} slugState={slugState} />
    <MetadataFields draft={draft} setDraft={setDraft} />
    {share.pendingSwitch ? null : <ShareButton variant="primary" className="-mt-1 font-semibold" disabled={blocked || share.operation !== null || share.loading || share.loadFailed} onClick={onPublish}>
      {publishing ? <Spinner /> : <Globe aria-hidden="true" className="size-[15px]" />}Publish
    </ShareButton>}
    {share.error?.operation === "publish" ? <InlineError>{share.error.message}</InlineError> : null}
    {submissions}
  </div>;
}

/** Live app: link, status, publish the latest app version, edit details, unpublish. */
function LivePublic({ share, draft, setDraft, slugState, onSaveDetails, submissions }: {
  share: ShareController; draft: PublicDraft; setDraft: (patch: Partial<PublicDraft>) => void; slugState: SlugState; onSaveDetails: () => void; submissions?: ReactNode;
}) {
  const copy = useCopy();
  const [editing, setEditing] = useState(false);
  const site = share.site!;
  const host = `matrix.page/${site.slug ?? site.id}`;
  const busy = share.operation !== null;
  return <div className="flex flex-col gap-2">
      <div className="flex h-11 items-center gap-2 rounded-lg border border-[var(--share-border)] bg-[var(--share-panel)] pl-3 pr-1">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--share-success)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{host}</span>
        <ShareButton variant="ghost" className="h-9 px-2.5 font-semibold text-[var(--share-fg)]" onClick={() => copy.copy("public", `https://${host}`)}>{copy.label("public", "Copy link")}</ShareButton>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--share-success-fg)]">Live</span>
        <ShareButton variant="link" className="text-[13px] text-[var(--share-muted-fg)]" disabled={busy} onClick={() => void share.unpublish()}>
          {share.operation === "unpublish" ? <Spinner /> : null}Unpublish
        </ShareButton>
      </div>
      <div className="flex items-center gap-1">
        <ShareButton size="sm" disabled={busy} title="Publish the latest version of the app" onClick={() => void share.publishUpdate()}>
          {share.operation === "update" ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-3.5" />}Update
        </ShareButton>
        <ShareButton size="icon" variant="ghost" className="size-8" aria-label="Edit details" title="Edit details" aria-expanded={editing} onClick={() => setEditing((value) => !value)}>
          <Pencil className="size-3.5" />
        </ShareButton>
      </div>
      {editing ? <div className="flex flex-col gap-3 border-t border-[var(--share-border)] pt-3">
        <SlugField share={share} draft={draft} setDraft={setDraft} slugState={slugState} />
        <MetadataFields draft={{ ...draft, metaOpen: true }} setDraft={setDraft} />
        <ShareButton variant="primary" size="sm" className="self-start" disabled={busy || slugBlocksPublish(slugState)} onClick={onSaveDetails}>
          {share.operation === "save" ? <Spinner /> : null}Save
        </ShareButton>
      </div> : null}
      {share.error && ["unpublish", "update", "save"].includes(share.error.operation) ? <InlineError>{share.error.message}</InlineError> : null}
      {submissions}
    </div>;
}

function SlugField({ share, draft, setDraft, slugState }: { share: ShareController; draft: PublicDraft; setDraft: (patch: Partial<PublicDraft>) => void; slugState: SlugState }) {
  const inputId = useId();
  const messageId = useId();
  const bad = slugBlocksPublish(slugState);
  return <div className="flex flex-col gap-1.5">
    <label htmlFor={inputId} className="text-xs font-medium">Path</label>
    <div className={cn("flex h-10 overflow-hidden rounded-lg border bg-[var(--share-bg)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--share-ring)]", bad ? "border-[var(--share-danger-border)]" : "border-[var(--share-input)]")}>
      <span aria-hidden="true" className="flex shrink-0 items-center border-r border-[var(--share-border)] bg-[var(--share-muted)] pl-3 pr-2.5 text-[13px] text-[var(--share-muted-fg)]">matrix.page/</span>
      <input id={inputId} value={draft.slug} placeholder={share.site?.id ?? "permanent-id"} spellCheck={false} autoComplete="off"
        aria-describedby={messageId} aria-invalid={bad}
        onChange={(event) => { share.clearSlugConflict(); setDraft({ slug: normalizeSlugInput(event.target.value) }); }}
        className="min-w-0 flex-1 border-0 bg-transparent px-3 text-[13px] font-semibold text-[var(--share-fg)] outline-none focus-visible:outline-none placeholder:font-normal placeholder:text-[var(--share-subtle-fg)]" />
    </div>
    <div id={messageId} aria-live="polite"><SlugMessage state={slugState} onPick={(slug) => { share.clearSlugConflict(); setDraft({ slug }); }} /></div>
  </div>;
}

function SlugMessage({ state, onPick }: { state: SlugState; onPick: (slug: string) => void }) {
  switch (state.kind) {
    case "empty": return null;
    case "invalid": return <p className="m-0 text-xs font-medium leading-4 text-[var(--share-danger-fg)]">2–63 lowercase letters, numbers, hyphens.</p>;
    case "reserved": return <p className="m-0 text-xs font-medium text-[var(--share-danger-fg)]">Reserved</p>;
    case "checking": return <BusyStatus label="Checking" className="text-xs" />;
    case "available":
    case "current": return <p className="m-0 flex items-center gap-1 text-xs font-medium text-[var(--share-success-fg)]"><Check aria-hidden="true" className="size-[13px]" strokeWidth={2.6} />Available</p>;
    case "unknown": return <p className="m-0 text-xs text-[var(--share-subtle-fg)]">Couldn’t check</p>;
    case "taken": return <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--share-muted-fg)]">
      <span className="font-medium text-[var(--share-danger-fg)]">Taken.</span>
      {state.suggestions.map((suggestion) => <ShareButton key={suggestion} size="sm" className="h-7 rounded-full px-2.5" onClick={() => onPick(suggestion)}>{suggestion}</ShareButton>)}
    </div>;
  }
}

function MetadataFields({ draft, setDraft }: { draft: PublicDraft; setDraft: (patch: Partial<PublicDraft>) => void }) {
  const contentId = useId();
  const titleId = useId();
  const descriptionId = useId();
  return <ShareCollapsible open={draft.metaOpen} onOpenChange={(metaOpen) => setDraft({ metaOpen })} className="flex flex-col gap-2.5">
    <ShareCollapsibleTrigger aria-controls={contentId} className="-my-1 flex h-8 w-full items-center gap-2 bg-transparent p-0 text-left">
      <ChevronRight aria-hidden="true" className={cn("size-3.5 text-[var(--share-subtle-fg)] transition-transform", draft.metaOpen && "rotate-90")} />
      <span className="text-[13px] font-medium">Title &amp; description</span>
      {draft.metaOpen ? null : <span className="min-w-0 flex-1 truncate text-right text-xs text-[var(--share-subtle-fg)]">{metadataSummary(draft.title, draft.description)}</span>}
    </ShareCollapsibleTrigger>
    <ShareCollapsibleContent id={contentId} className="flex flex-col gap-2.5 pl-[22px]">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={titleId} className="text-xs font-medium">Title</label>
        <ShareInput id={titleId} value={draft.title} maxLength={SHARE_TITLE_MAX} placeholder="App name" onChange={(event) => setDraft({ title: event.target.value.slice(0, SHARE_TITLE_MAX) })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <label htmlFor={descriptionId} className="text-xs font-medium">Description</label>
          {draft.description.length > SHARE_DESCRIPTION_COUNTER_FROM ? <span className="text-xs text-[var(--share-muted-fg)]" aria-live="polite">{draft.description.length}/{SHARE_DESCRIPTION_MAX}</span> : null}
        </div>
        <ShareTextarea id={descriptionId} rows={2} value={draft.description} maxLength={SHARE_DESCRIPTION_MAX} placeholder="What it does" onChange={(event) => setDraft({ description: event.target.value.slice(0, SHARE_DESCRIPTION_MAX) })} />
      </div>
    </ShareCollapsibleContent>
  </ShareCollapsible>;
}
