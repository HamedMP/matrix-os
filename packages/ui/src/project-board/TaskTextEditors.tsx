"use client";

import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { chipButtonClass, focusOnMount, focusRing, tone } from "./board-style.js";
import { markdownClass } from "./TaskTimeline.js";
import { TASK_LIMITS, type ProjectTask } from "./types.js";
import type { UpdateResult } from "./use-project-board.js";

/**
 * Saves the text over `base`, the server copy the edit started from (or, after "Keep mine", the copy that won).
 * Saving against that revision, not the latest one, is what lets the server report a lost race.
 */
export type TextSave = (text: string, base: ProjectTask) => Promise<UpdateResult>;

/**
 * Spec 2699 journey 7: the person's text stays on screen next to the version
 * that won the race, and they pick one. Nothing is overwritten silently.
 */
function ConflictChoice({ field, mine, theirs, busy, onKeepMine, onUseTheirs }: {
  field: string; mine: string; theirs: string; busy: boolean; onKeepMine(): void; onUseTheirs(): void;
}) {
  return <div role="alert" aria-label={`The ${field} changed while you were editing`} className="mt-2 rounded-[14px] border p-3 text-[13px]"
    style={{ borderColor: "var(--warning, var(--border-default, var(--border)))", ...tone.primary }}>
    <p className="font-medium">Someone else changed the {field} while you were editing.</p>
    <div className="mt-2 grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
      {([["Yours", mine], ["Theirs", theirs]] as const).map(([label, text]) => <div key={label} className="min-w-0">
        <p className="mb-1 text-[12px] font-medium" style={tone.muted}>{label}</p>
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] px-2 py-1.5"
          style={{ background: "var(--bg-sunken, var(--muted))" }}>{text.trim() ? text : <span style={tone.muted}>Empty</span>}</div>
      </div>)}
    </div>
    <div className="mt-2 flex justify-end gap-2">
      <button type="button" className={chipButtonClass} style={tone.secondary} disabled={busy} onClick={onUseTheirs}>Use theirs</button>
      <button type="button" className={chipButtonClass} style={tone.primary} disabled={busy} onClick={onKeepMine}>Keep mine</button>
    </div>
  </div>;
}

/**
 * The copy an edit started from, and a lost save's winning copy. A change signal can refresh `task` mid-edit;
 * the edit keeps saving against the revision it began from until the person resolves the conflict.
 */
function useTextEdit(onSave: TextSave) {
  const [base, setBase] = useState<ProjectTask | null>(null);
  const [saved, setSaved] = useState<ProjectTask | null>(null);
  const [conflict, setConflict] = useState<ProjectTask | null>(null);
  const [busy, setBusy] = useState(false);
  // Our own last save can be newer than `task` until the board's refetch lands.
  const begin = (task: ProjectTask) => setBase(saved && saved.revision > task.revision ? saved : task);
  const save = async (text: string, against: ProjectTask): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await onSave(text, against);
      setConflict(result.conflict ?? null);
      if (result.task) { setSaved(result.task); setBase(null); }
      return result.task !== undefined;
    } finally {
      setBusy(false);
    }
  };
  const clear = () => { setConflict(null); setBase(null); };
  return { base, conflict, busy, begin, save, clear };
}

export function TitleEditor({ task, onSave }: { task: ProjectTask; onSave: TextSave }) {
  const title = task.title;
  const [value, setValue] = useState(title);
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(title);
  const { base, conflict, busy, begin, save, clear } = useTextEdit(onSave);
  // Follow edits from elsewhere, but never during an edit: while typing, saving, or deciding a conflict.
  if (title !== shown && !focused && !conflict && !base) { setShown(title); setValue(title); }
  const commit = () => {
    const from = base ?? task;
    const trimmed = value.trim();
    if (!trimmed) { setValue(title); clear(); return; }
    // Untouched since the edit began: nothing to save, and a newer title from elsewhere shows instead.
    if (trimmed === from.title) { clear(); return; }
    void save(trimmed, from);
  };
  return <div className="shrink-0 px-5 pb-2">
    <textarea aria-label="Task title" rows={1} maxLength={TASK_LIMITS.title} value={value} onChange={(event) => setValue(event.currentTarget.value)}
      onFocus={() => { setFocused(true); if (!conflict && !base) begin(task); }}
      onBlur={() => { setFocused(false); if (!conflict) commit(); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape" && value !== title) { event.preventDefault(); setValue(title); }
      }}
      className="block w-full resize-none rounded-lg bg-transparent px-1 py-0.5 text-[22px] font-semibold leading-[30px] outline-none [field-sizing:content] hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)]"
      style={tone.primary} />
    {conflict ? <ConflictChoice field="title" mine={value} theirs={conflict.title} busy={busy}
      onKeepMine={() => void save(value.trim() || conflict.title, conflict)}
      onUseTheirs={() => { setValue(conflict.title); setShown(conflict.title); clear(); }} /> : null}
  </div>;
}

/** Links in task text open outside the shell and never start editing the description they sit in. */
const EXTERNAL_LINKS = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => <a href={href} target="_blank" rel="noreferrer noopener"
    onClick={(event) => event.stopPropagation()}>{children}</a>,
};

export function DescriptionEditor({ task, onSave }: { task: ProjectTask; onSave: TextSave }) {
  const description = task.description;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description);
  const [preview, setPreview] = useState(false);
  const [shown, setShown] = useState(description);
  const { base, conflict, busy, begin, save, clear } = useTextEdit(onSave);
  if (description !== shown && !editing) { setShown(description); setValue(description); }
  if (!editing) {
    const startEditing = () => { setEditing(true); begin(task); };
    // Text and links stay readable and clickable; a separate button starts editing, so a link is never inside a button.
    return <div className="group relative rounded-[14px] p-2 hover:bg-[var(--bg-hover)]">
      {description.trim()
        ? <div className={markdownClass} style={tone.primary}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={EXTERNAL_LINKS}>{description}</ReactMarkdown></div>
        : <span className="text-[14px]" style={tone.muted}>No description yet.</span>}
      <button type="button" onClick={startEditing} aria-label="Edit description"
        className={`${description.trim() ? "absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "mt-1 block"} ${chipButtonClass}`}
        style={tone.secondary}>{description.trim() ? "Edit description" : "Add a description"}</button>
    </div>;
  }
  const close = () => { setEditing(false); setPreview(false); clear(); };
  /** `winner`: save over the copy that won a race, after "Keep mine". */
  const commit = async (winner?: ProjectTask) => {
    const from = winner ?? base ?? task;
    if (!winner && value === from.description) { close(); return; }
    // A failed save keeps the editor open, so the text is never lost.
    if (await save(value, from)) close();
  };
  const cancel = () => { setValue(description); close(); };
  return <div className="rounded-[14px] border p-2" style={{ ...tone.border, background: "var(--bg-sunken, var(--muted))" }}>
    <div role="group" aria-label="Description mode" className="mb-2 flex gap-1">
      {([false, true] as const).map((mode) => <button key={String(mode)} type="button" aria-pressed={preview === mode} onClick={() => setPreview(mode)}
        className={chipButtonClass} style={tone.primary}>{mode ? "Preview" : "Write"}</button>)}
    </div>
    {preview
      ? <div className={`${markdownClass} min-h-[120px] px-1`} style={tone.primary}>{value.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={EXTERNAL_LINKS}>{value}</ReactMarkdown> : <span style={tone.muted}>Nothing to preview</span>}</div>
      : <textarea aria-label="Description" rows={8} maxLength={TASK_LIMITS.description} value={value} onChange={(event) => setValue(event.currentTarget.value)}
        // Read-only while a save is in flight, so nothing typed after Save is dropped when it closes.
        readOnly={busy} aria-busy={busy}
        ref={focusOnMount}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!conflict) void commit(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
        }}
        placeholder="Markdown supported"
        className="block w-full resize-y bg-transparent px-1 font-mono text-[13px] leading-5 outline-none" style={tone.primary} />}
    {conflict ? <ConflictChoice field="description" mine={value} theirs={conflict.description} busy={busy}
      onKeepMine={() => void commit(conflict)}
      onUseTheirs={() => { setValue(conflict.description); close(); }} /> : <div className="mt-2 flex justify-end gap-2">
      <button type="button" className={chipButtonClass} style={tone.secondary} onClick={cancel}>Cancel</button>
      <button type="button" className={chipButtonClass} style={tone.primary} disabled={busy} onClick={() => void commit()}>{busy ? "Saving…" : "Save"}</button>
    </div>}
  </div>;
}
