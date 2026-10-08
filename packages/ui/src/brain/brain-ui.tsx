"use client";

import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { CircleAlert, ExternalLink, Inbox, LoaderCircle, TriangleAlert } from "lucide-react";
import { BrainButton } from "./brain-controls.js";
import { BRAIN_TONE, BRAIN_TYPE } from "./brain-tone.js";
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

/** An error box: words and an icon on the fill, Gold when a source is missing (needs attention), else Coral (failed). */
export const BRAIN_NOTICE = `flex flex-wrap items-center gap-3 p-3 ${BRAIN_TONE.fill} ${BRAIN_TYPE.label}`;

export function BrainError({ error, onRetry, onOpenSources }: {
  readonly error: BrainShellErrorState; readonly onRetry?: () => void; readonly onOpenSources?: () => void;
}) {
  const icon = isBrainNotConnected(error) ? BRAIN_TONE.iconWarn : BRAIN_TONE.danger;
  return (
    <div role="alert" className={BRAIN_NOTICE}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <TriangleAlert className={`mt-0.5 size-4 shrink-0 ${icon}`} aria-hidden="true" />
        <p className="min-w-0 flex-1">{brainErrorText(error)}</p>
      </div>
      {onOpenSources && isBrainNotConnected(error) && (
        <BrainButton size="sm" variant="outline" onClick={onOpenSources}>Open Sources</BrainButton>
      )}
      {onRetry && <BrainButton size="sm" variant="outline" onClick={onRetry}>Try again</BrainButton>}
    </div>
  );
}

/** A line of failure text: Coral 500 words with an icon, or (`attention`) primary words with a Gold icon. */
export function BrainAlertText({ children, attention = false, className, ...props }: {
  readonly children: ReactNode; readonly attention?: boolean; readonly className?: string; readonly id?: string;
  readonly role?: "alert" | "status";
}) {
  return (
    <p className={[`flex items-start gap-1.5 ${BRAIN_TYPE.caption}`, attention ? BRAIN_TONE.text : BRAIN_TONE.danger,
      className].filter(Boolean).join(" ")} {...props}>
      <CircleAlert className={`mt-px size-4 shrink-0 ${attention ? BRAIN_TONE.iconWarn : ""}`} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Loading text; the spinner stops under reduced motion. */
export function BrainLoading({ label }: { readonly label: string }) {
  return (
    <p role="status" className={`flex items-center gap-2 py-3 ${BRAIN_TYPE.label} ${BRAIN_TONE.secondary}`}>
      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {label}
    </p>
  );
}

/** An empty state: a quiet icon, the headline and what to do next. */
export function BrainEmpty({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div data-slot="brain-empty" className={`flex items-start gap-3 p-4 ${BRAIN_TONE.fill} ${BRAIN_TYPE.label}`}>
      <Inbox className={`mt-0.5 size-4 shrink-0 ${BRAIN_TONE.secondary}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={`font-semibold ${BRAIN_TYPE.callout}`}>{title}</p>
        {children && <div className={`mt-1.5 ${BRAIN_TONE.secondary}`}>{children}</div>}
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

/** A label badge: 8 px corners, Micro type; a status badge adds a Teal (good) or Gold (warn) dot beside its words. */
export function BrainBadge({ children, tone = "plain" }: {
  readonly children: ReactNode; readonly tone?: "plain" | "warn" | "good";
}) {
  const dot = tone === "good" ? BRAIN_TONE.dotGood : tone === "warn" ? BRAIN_TONE.dotWarn : null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-[8px] bg-[var(--brain-chip)] px-1.5 py-0.5 font-medium ${BRAIN_TYPE.micro} ${BRAIN_TONE.secondary}`}>
      {dot && <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />}
      {children}
    </span>
  );
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
    <span className={`inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5 ${BRAIN_TYPE.footnote} ${BRAIN_TONE.secondary}`}>
      {cite.label !== title && <BrainBadge>{cite.label}</BrainBadge>}
      {cite.permalink.startsWith("https://") ? (
        <a href={cite.permalink} target="_blank" rel="noopener noreferrer"
          className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-[6px] underline-offset-2 hover:underline ${
            BRAIN_TONE.text} ${BRAIN_TONE.hit} ${BRAIN_TONE.focus}`}>
          {text}
          <ExternalLink className="size-3 shrink-0" aria-label="opens in a new tab" />
        </a>
      ) : text !== null && <span className={`min-w-0 truncate ${BRAIN_TONE.text}`}>{title}</span>}
      <time dateTime={cite.date} className={BRAIN_TONE.tertiary}>{brainDay(cite.date)}</time>
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
    parts.push(text.slice(at, start), <mark key={start} className={`rounded-[6px] px-0.5 ${BRAIN_TONE.text} ${BRAIN_TONE.mark}`}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(text.slice(at));
  return <p className={BRAIN_TYPE.callout}>{parts}</p>;
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
    <p role="status" className={`${BRAIN_TYPE.caption} ${BRAIN_TONE.secondary}`}>
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
    <div className={`grid gap-2 ${BRAIN_TYPE.label}`}>
      <div className="flex flex-wrap items-center gap-2">
        {/* Blue: syncing and neutral progress. */}
        {watch.phase === "watching" && (
          <progress aria-label={`${label} progress`} className="h-1.5 w-24 shrink-0 accent-[var(--brain-info)]" />
        )}
        <p role="status" className="min-w-0 flex-1">{brainJobText(label, watch.view)}</p>
        {watch.phase === "watching" && (
          <BrainButton size="sm" variant="outline" disabled={job.cancelling} onClick={job.stop}>
            {job.cancelling ? "Stopping..." : "Stop"}
          </BrainButton>
        )}
      </div>
      {watch.phase === "stopped" && (watch.error === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className={`min-w-0 flex-1 ${BRAIN_TONE.secondary}`}>It is still running. Check again later.</p>
          <BrainButton size="sm" variant="outline" onClick={job.checkAgain}>Check again</BrainButton>
        </div>
      ) : <BrainError error={watch.error} onRetry={job.checkAgain} />)}
      {job.cancelError && <BrainError error={job.cancelError} />}
    </div>
  );
}
