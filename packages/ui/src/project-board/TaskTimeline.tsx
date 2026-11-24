"use client";

import { useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { actorName, formatRelative } from "./board-format.js";
import { ActorAvatar } from "./board-primitives.js";
import { focusRing, primaryButtonClass, tone } from "./board-style.js";
import { insertMention, mentionQueryAt } from "./mentions.js";
import type { TimelineEntry } from "./use-task-detail.js";
import type { BoardMember } from "./types.js";

const MAX_SUGGESTIONS = 6;

export const markdownClass = "text-[14px] leading-[21px] break-words [&_a]:underline [&_code]:rounded [&_code]:bg-[var(--bg-sunken,var(--muted))] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px] [&_li]:ml-5 [&_ol]:list-decimal [&_p+p]:mt-2 [&_p+ul]:mt-1 [&_p+ol]:mt-1 [&_ul]:list-disc [&_strong]:font-semibold";

/** Comment and description Markdown; raw HTML is skipped and links open outside the shell. */
function MarkdownBody({ body }: { body: string }) {
  return <div className={markdownClass} style={tone.primary}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
      components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>
      {body}
    </ReactMarkdown>
  </div>;
}

export function TaskTimeline({ entries, status, members, nowMs, onRetry }: {
  entries: readonly TimelineEntry[]; status: "loading" | "ready" | "error"; members: readonly BoardMember[]; nowMs: number; onRetry(): void;
}) {
  if (status === "loading") return <p role="status" className="py-4 text-[12px]" style={tone.muted}>Loading activity…</p>;
  if (status === "error") {
    return <p role="alert" className="py-4 text-[12px]" style={tone.secondary}>
      Activity could not be loaded. <button type="button" className="underline" onClick={onRetry}>Try again</button>
    </p>;
  }
  return <ol aria-label="Comments and activity" className="flex flex-col">
    {entries.map((entry) => entry.kind === "activity"
      ? <li key={entry.key} className="flex items-center gap-2 py-1.5 pl-1 text-[12.5px]" style={tone.muted}>
        <span aria-hidden="true" className="mx-[5px] size-1.5 shrink-0 rounded-full" style={{ background: "var(--border-default, var(--border))" }} />
        <span className="min-w-0"><span className="font-medium" style={tone.secondary}>{actorName(members, entry.activity.actor)}</span> {entry.activity.summary.charAt(0).toLowerCase() + entry.activity.summary.slice(1)}</span>
        <time dateTime={entry.at} className="ml-auto shrink-0">{formatRelative(entry.at, nowMs)}</time>
      </li>
      : <li key={entry.key} className="my-1.5 flex gap-2.5 rounded-[14px] border p-3" style={{ ...tone.border, background: "var(--bg-surface, var(--card))" }}>
        <ActorAvatar members={members} actor={entry.comment.author} size={24} />
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-baseline gap-2 text-[12.5px]">
            <span className="font-semibold" style={tone.primary}>{actorName(members, entry.comment.author)}</span>
            <time dateTime={entry.at} style={tone.muted}>{formatRelative(entry.at, nowMs)}</time>
          </div>
          <MarkdownBody body={entry.comment.body} />
        </div>
      </li>)}
  </ol>;
}

/** Comment box with `@` suggestions from the board's members; Cmd/Ctrl+Enter sends. */
export function CommentComposer({ members, onSubmit }: { members: readonly BoardMember[]; onSubmit(body: string): Promise<boolean> }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const mention = mentionQueryAt(text, caret);
  const suggestions = mention && dismissedAt !== mention.start
    ? members.filter((member) => member.handle.toLowerCase().startsWith(mention.query.toLowerCase())
      || member.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, MAX_SUGGESTIONS)
    : [];
  const active = suggestions.length > 0 ? Math.min(highlight, suggestions.length - 1) : -1;

  const pick = (member: BoardMember) => {
    if (!mention) return;
    const next = insertMention(text, mention.start, caret, member.handle);
    setText(next.text);
    setCaret(next.caret);
    setHighlight(0);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret); });
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      if (await onSubmit(text)) { setText(""); setCaret(0); }
    } finally {
      setBusy(false);
    }
  };

  return <div className="relative mt-3">
    <label htmlFor={`${id}-comment`} className="sr-only">Add a comment</label>
    <textarea id={`${id}-comment`} ref={input} rows={3} maxLength={10_000} value={text} disabled={busy}
      placeholder="Leave a comment… type @ to mention someone"
      role="combobox" aria-expanded={suggestions.length > 0} aria-controls={`${id}-mentions`} aria-autocomplete="list"
      aria-activedescendant={active >= 0 ? `${id}-mention-${suggestions[active]!.handle}` : undefined}
      onChange={(event) => { setText(event.currentTarget.value); setCaret(event.currentTarget.selectionStart); setDismissedAt(null); }}
      onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
      onKeyDown={(event) => {
        if (suggestions.length > 0) {
          if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((active + 1) % suggestions.length); return; }
          if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((active - 1 + suggestions.length) % suggestions.length); return; }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(suggestions[active]!); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissedAt(mention?.start ?? null); return; }
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
      }}
      className="block w-full resize-y rounded-[14px] border bg-[var(--bg-sunken,var(--muted))] px-3 py-2 text-[14px] leading-5 outline-none focus:border-[var(--text-primary,var(--foreground))]"
      style={{ ...tone.border, ...tone.primary }} />
    {suggestions.length > 0 ? <ul id={`${id}-mentions`} role="listbox" aria-label="Mention a member"
      className="absolute left-2 top-full mt-1 w-56 rounded-xl border p-1 shadow-lg"
      style={{ zIndex: 1, borderColor: "var(--border-default, var(--border))", background: "var(--bg-overlay, var(--popover, var(--card)))" }}>
      {suggestions.map((member, index) => <li key={member.actor} id={`${id}-mention-${member.handle}`} role="option" aria-selected={index === active}
        onMouseDown={(event) => { event.preventDefault(); pick(member); }}
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] aria-selected:bg-[var(--bg-hover)]" style={tone.primary}>
        <ActorAvatar members={members} actor={member.actor} size={18} />
        <span className="truncate">{member.name}</span>
        <span className="ml-auto text-[12px]" style={tone.muted}>@{member.handle}</span>
      </li>)}
    </ul> : null}
    <div className="mt-2 flex items-center justify-end gap-2">
      <span className="text-[11.5px]" style={tone.muted}>⌘/Ctrl + Enter</span>
      <button type="button" className={`${primaryButtonClass} ${focusRing}`} disabled={!text.trim() || busy} onClick={() => void send()}>
        {busy ? "Sending…" : "Comment"}
      </button>
    </div>
  </div>;
}
