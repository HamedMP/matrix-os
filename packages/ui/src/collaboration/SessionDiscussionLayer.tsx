import { useEffect, useRef } from "react";
import type { ReturnTypeOfUseSessionDiscussion } from "./session-discussion-types.js";

export function SessionDiscussionLayer({ open, onClose, discussion }: {
  open: boolean;
  onClose(): void;
  discussion: ReturnTypeOfUseSessionDiscussion;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);
  if (!open) return null;
  return <div className="absolute inset-0 z-30" data-slot="session-discussion-layer">
    <button type="button" aria-label="Close discussion" className="absolute inset-0 bg-black/20" onClick={onClose} />
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="session-discussion-title"
      className="absolute inset-y-0 right-0 flex w-full flex-col border-l bg-background shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right sm:w-96 max-sm:border-l-0">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b px-4">
        <div><h2 id="session-discussion-title" className="font-semibold">Discussion</h2>
          <p className="text-xs text-muted-foreground">Notes for people in this session—not prompts for AI.</p></div>
        <button ref={closeRef} type="button" aria-label="Close discussion panel" onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm hover:bg-[var(--bg-hover)]">Close</button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {discussion.loading ? <p role="status">Loading discussion…</p> : null}
        {!discussion.loading && !discussion.messages.length ? <p className="py-10 text-center text-sm text-muted-foreground">No notes yet.</p> : null}
        {discussion.messages.map((message) => <article key={message.id} className="rounded-xl border p-3">
          <header className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">{message.actor.displayName}</span>
            <time className="text-muted-foreground" dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          </header>
          <p className="whitespace-pre-wrap text-sm">{message.text}</p>
        </article>)}
        {discussion.hasMore ? <div className="text-center"><button type="button"
          aria-label="Load more discussion notes" disabled={discussion.loading}
          onClick={() => void discussion.loadMore()}
          className="rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-50">
          {discussion.loading ? "Loading…" : "Load more notes"}
        </button></div> : null}
      </div>
      <footer className="border-t p-4">
        {discussion.error ? <p role="alert" className="mb-2 text-xs text-destructive">Discussion is unavailable. Try again.</p> : null}
        <label><span className="sr-only">Add a discussion note</span>
          <textarea aria-label="Add a discussion note" rows={3} value={discussion.draft}
            disabled={discussion.readOnly || discussion.sending}
            placeholder={discussion.readOnly ? "View-only discussion" : "Add a note for collaborators…"}
            onChange={(event) => discussion.setDraft(event.target.value)}
            className="block w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm disabled:opacity-60" />
        </label>
        <div className="mt-2 flex justify-end"><button type="button" disabled={discussion.readOnly || discussion.sending || !discussion.draft.trim()}
          onClick={() => void discussion.send()} className="rounded-xl border px-4 py-2 text-sm font-medium disabled:opacity-50">
          {discussion.sending ? "Posting…" : "Post note"}
        </button></div>
      </footer>
    </section>
  </div>;
}
