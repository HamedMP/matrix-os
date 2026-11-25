"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SentIcon } from "@hugeicons/core-free-icons";
import { activeMentionQuery, actorLabel, insertMention, mentionHandle, type MentionQuery } from "./model.js";
import { subtleBorder, textPrimary, textTertiary } from "./presentation.js";
import { BoardButton } from "./controls.js";
import type { BoardActor } from "./types.js";
import type { MutationResult } from "./use-message-board.js";

const MAX_TEXT = 10_000;
const MAX_SUGGESTIONS = 6;

export interface BoardComposerProps {
  label: string;
  placeholder: string;
  submitLabel: string;
  actors: readonly BoardActor[];
  viewerId: string;
  initialText?: string;
  autoFocus?: boolean;
  /** Extra controls on the toolbar row, e.g. "Make this a task". */
  toolbar?: ReactNode;
  onSubmit(text: string): Promise<MutationResult>;
  onCancel?: () => void;
}

/** Markdown composer with `@` mention suggestions; Enter sends, Shift+Enter adds a line, Escape cancels. */
export function BoardComposer({ label, placeholder, submitLabel, actors, viewerId, initialText = "", autoFocus, toolbar, onSubmit, onCancel }: BoardComposerProps) {
  const [text, setText] = useState(initialText);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return actors
      .filter((actor) => actor.id !== viewerId && actor.kind !== "system")
      .filter((actor) => mentionHandle(actor).includes(query) || actor.name.toLowerCase().includes(query))
      .slice(0, MAX_SUGGESTIONS);
  }, [actors, mention, viewerId]);

  const updateMention = (value: string, caret: number) => {
    setMention(activeMentionQuery(value, caret));
    setHighlight(0);
  };

  const pick = (actor: BoardActor) => {
    if (!mention) return;
    const next = insertMention(text, mention, mentionHandle(actor));
    setText(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await onSubmit(value);
      if (result.ok) setText("");
      else setError(result.error);
    } finally {
      setPending(false);
    }
  };

  const open = suggestions.length > 0;
  return <div className="relative">
    {open ? <ul id={listId} role="listbox" aria-label="Mention someone"
      className="absolute bottom-full left-2 mb-1 w-64 rounded-xl border p-1 shadow-lg" style={{ ...subtleBorder, background: "var(--bg-overlay, var(--popover))" }}>
      {suggestions.map((actor, index) => <li key={actor.id} id={`${listId}-${index}`} role="option" aria-selected={index === highlight}
        onMouseDown={(event) => { event.preventDefault(); pick(actor); }}
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--bg-hover)]"
        style={{ ...textPrimary, ...(index === highlight ? { background: "var(--bg-hover)" } : {}) }}>
        <span className="font-mono text-xs">@{mentionHandle(actor)}</span>
        <span className="min-w-0 flex-1 truncate text-xs" style={textTertiary}>{actorLabel(actor)}</span>
      </li>)}
    </ul> : null}
    <div className="rounded-[14px] border px-2.5 pb-2 pt-2 focus-within:border-[var(--text-primary,currentColor)]"
      style={{ ...subtleBorder, background: "var(--bg-surface, var(--card))" }}>
      <textarea ref={input} aria-label={label} placeholder={placeholder} value={text} rows={2} maxLength={MAX_TEXT}
        autoFocus={autoFocus} disabled={pending}
        aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
        onChange={(event) => { setText(event.currentTarget.value); updateMention(event.currentTarget.value, event.currentTarget.selectionStart); }}
        onSelect={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setHighlight((value) => (value + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
          } else if (open && (event.key === "Enter" || event.key === "Tab")) {
            event.preventDefault();
            pick(suggestions[highlight]!);
          } else if (event.key === "Escape") {
            event.stopPropagation();
            if (open) setMention(null);
            else onCancel?.();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        className="block max-h-48 min-h-[2.75rem] w-full resize-none bg-transparent text-[14px] leading-[1.45] outline-none" style={textPrimary} />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {toolbar}
        <span className="flex-1" />
        {onCancel ? <BoardButton look="plain" onClick={onCancel} className="h-8 rounded-[10px] px-2.5 text-[13px] outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--primary,currentColor))]" style={textTertiary}>Cancel</BoardButton> : null}
        <BoardButton look="primary" disabled={pending || text.trim().length === 0} onClick={() => void submit()}>
          <HugeiconsIcon icon={SentIcon} size={13} aria-hidden /> {submitLabel}
        </BoardButton>
      </div>
    </div>
    {error ? <p role="alert" className="px-1 pt-1 text-xs" style={{ color: "var(--danger-text)" }}>{error}</p> : null}
  </div>;
}
