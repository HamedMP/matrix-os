"use client";

import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { ExternalLink, Inbox, LoaderCircle, TriangleAlert } from "lucide-react";
import { BrainButton } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import { brainDay, brainErrorText, brainJobText, isBrainNotConnected } from "./brain-format.js";
import type { BrainShellClient, BrainShellErrorState } from "./brain-types.js";
import type { useBrainJob } from "./use-brain-job.js";
import type { BrainLoad } from "./use-brain-load.js";

/** What every screen gets from the app. */
export interface BrainScreenProps {
  readonly api: BrainShellClient;
  readonly projectId: string;
  readonly onOpenSources: () => void;
}

export function BrainError({ error, onRetry, onOpenSources }: {
  readonly error: BrainShellErrorState; readonly onRetry?: () => void; readonly onOpenSources?: () => void;
}) {
  return (
    <div role="alert" className={`flex flex-wrap items-start gap-3 rounded-md border p-3 text-sm ${BRAIN_TONE.warn}`}>
      <TriangleAlert className={`mt-0.5 size-4 shrink-0 ${BRAIN_TONE.warnText}`} aria-hidden="true" />
      <p className="min-w-0 flex-1">{brainErrorText(error)}</p>
      {onOpenSources && isBrainNotConnected(error) && (
        <BrainButton size="sm" variant="outline" onClick={onOpenSources}>Open Sources</BrainButton>
      )}
      {onRetry && <BrainButton size="sm" variant="outline" onClick={onRetry}>Try again</BrainButton>}
    </div>
  );
}

export function BrainLoading({ label }: { readonly label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

/** An empty state: a quiet icon, the headline and what to do next. */
export function BrainEmpty({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 rounded-md border border-dashed p-4 text-sm ${BRAIN_TONE.border}`}>
      <Inbox className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-2 text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

/**
 * A confirm that floats over the content below its trigger, so opening it moves nothing: it spans the nearest
 * positioned ancestor, just under it, and paints over the view's unpositioned content without a z-index of its own.
 * The trigger toggles `open` (the caller's state); a click outside the trigger and the panel, or Escape, closes it
 * through `onClose`.
 */
export function BrainConfirm({ open, onClose, label, trigger, children }: {
  readonly open: boolean; readonly onClose: () => void; readonly label: string; readonly trigger: ReactNode;
  readonly children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!open) return undefined;
    const inside = (target: EventTarget | null) => target instanceof Node
      && (anchor.current?.contains(target) === true || panel.current?.contains(target) === true);
    const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) close(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return (
    <>
      <span ref={anchor} className="contents">{trigger}</span>
      {open && (
        <div ref={panel} role="dialog" aria-label={label}
          className={`absolute inset-x-0 top-full mt-2 grid gap-2 rounded-md border p-3 text-sm ${BRAIN_TONE.border} ${BRAIN_TONE.overlay}`}>
          {children}
        </div>
      )}
    </>
  );
}

/** Loading, error (with retry and the way to Sources) or the ready content of one request. */
export function BrainView<T>({ state, label, onRetry, onOpenSources, children }: {
  readonly state: BrainLoad<T>; readonly label: string; readonly onRetry: () => void;
  readonly onOpenSources?: () => void; readonly children: (data: T) => ReactNode;
}) {
  if (state.status === "ready") return <>{children(state.data)}</>;
  if (state.status === "error") return <BrainError error={state.error} onRetry={onRetry} onOpenSources={onOpenSources} />;
  if (state.status === "loading") return <BrainLoading label={label} />;
  return null;
}

export function BrainBadge({ children, tone = "plain" }: {
  readonly children: ReactNode; readonly tone?: "plain" | "warn" | "good";
}) {
  const tones = { plain: `${BRAIN_TONE.border} text-muted-foreground`, warn: BRAIN_TONE.badgeWarn, good: BRAIN_TONE.badgeGood };
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

/**
 * A document reference: label, title and day; the title links out only for an https permalink. Text the line already
 * shows (`shown`) and a label equal to the title are not repeated.
 */
export function BrainCite({ cite, shown }: {
  readonly cite: { readonly label: string; readonly title: string; readonly date: string; readonly permalink: string };
  readonly shown?: string;
}) {
  const title = cite.title === "" ? cite.label : cite.title;
  // min-w-0: a flex item never shrinks below its text otherwise, and one long title would widen the whole screen.
  const text = title === shown ? null : <span className="min-w-0 truncate">{title}</span>;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {cite.label !== title && <BrainBadge>{cite.label}</BrainBadge>}
      {cite.permalink.startsWith("https://") ? (
        <a href={cite.permalink} target="_blank" rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1 truncate text-foreground underline-offset-2 hover:underline">
          {text}
          <ExternalLink className="size-3 shrink-0" aria-label="opens in a new tab" />
        </a>
      ) : text !== null && <span className="min-w-0 truncate text-foreground">{title}</span>}
      <time dateTime={cite.date}>{brainDay(cite.date)}</time>
    </span>
  );
}

/** Plain text with [start, end) ranges marked; ranges are sorted and never overlap. */
export function BrainSnippet({ text, highlights }: {
  readonly text: string; readonly highlights: readonly (readonly [number, number])[];
}) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of highlights) {
    if (start < at || end > text.length || end <= start) continue;
    parts.push(text.slice(at, start), <mark key={start} className={`rounded px-0.5 text-foreground ${BRAIN_TONE.mark}`}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));
  return <p className="text-sm leading-relaxed">{parts}</p>;
}

export function BrainLoadMore({ nextCursor, loading, error, onLoadMore }: {
  readonly nextCursor: string | null; readonly loading: boolean; readonly error: BrainShellErrorState | null;
  readonly onLoadMore: () => void;
}) {
  return (
    <div className="grid gap-2">
      {error && <BrainError error={error} />}
      {nextCursor !== null && (
        <BrainButton variant="outline" size="sm" className="justify-self-start" disabled={loading} onClick={onLoadMore}>
          {loading ? "Loading..." : "Load more"}
        </BrainButton>
      )}
    </div>
  );
}

export function BrainFreshness({ pending, capped }: { readonly pending: number; readonly capped: boolean }) {
  if (pending === 0) return null;
  return (
    <p role="status" className="text-xs text-muted-foreground">
      Still reading {pending}{capped ? "+" : ""} new documents; results may be incomplete.
    </p>
  );
}

/** A background run: progress while it runs (with Stop), then its result; "Check again" when polling gave up. */
export function BrainJobProgress({ job, labels }: {
  readonly job: ReturnType<typeof useBrainJob>; readonly labels: Readonly<Record<string, string>>;
}) {
  const { watch } = job;
  if (watch === null) return null;
  const label = labels[watch.name] ?? "Background run";
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {watch.phase === "watching" && <progress aria-label={`${label} progress`} className="h-1.5 w-24 shrink-0" />}
        <p role="status" className="min-w-0 flex-1">{brainJobText(label, watch.view)}</p>
        {watch.phase === "watching" && (
          <BrainButton size="sm" variant="outline" disabled={job.cancelling} onClick={job.stop}>
            {job.cancelling ? "Stopping..." : "Stop"}
          </BrainButton>
        )}
      </div>
      {watch.phase === "stopped" && (watch.error === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-muted-foreground">It is still running. Check again later.</p>
          <BrainButton size="sm" variant="outline" onClick={job.checkAgain}>Check again</BrainButton>
        </div>
      ) : <BrainError error={watch.error} onRetry={job.checkAgain} />)}
      {job.cancelError && <BrainError error={job.cancelError} />}
    </div>
  );
}
