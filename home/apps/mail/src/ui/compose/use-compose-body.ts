/**
 * Connects the composer body (a `ComposeBody`, possibly a redline) to the
 * store's draft. Every change is written with `editDraft`, so autosave and
 * its guards stay the store's. A body written by someone else (the mail
 * agent filling the draft) is shown as an assistant proposal: tracked
 * changes against what the composer had.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RedlineChange } from "../../../../_shared/office-engine/redline/index";
import type { DraftProposal, ProposalRegistry } from "../../agent/proposals";
import { ASSISTANT_AUTHOR, textToBodyHtml } from "../../compose/assistant";
import { ComposeBody, type EditAuthor } from "../../compose/compose-body";
import { hasTrackedMarkup } from "../../compose/redline-body";
import { peekBody, remember } from "../../compose/sessions";
import type { DraftState, MailStore } from "../../model";

/** Undo snapshots kept per composer. */
export const MAX_UNDO = 50;
/** Edits closer together than this share one undo step. */
const UNDO_COALESCE_MS = 1_000;

export interface ComposeBodyApi {
  /** What the editor shows (engine markup or clean HTML). */
  markup: string;
  /** Changes when the editor must re-apply `markup` to the DOM. */
  renderKey: number;
  changes: RedlineChange[];
  suggesting: boolean;
  finalText: string;
  /** The owner typed; `finalHtml` is the editor content without deletions. */
  onUserInput(finalHtml: string): void;
  propose(html: string): void;
  accept(ids: readonly string[] | "all"): void;
  reject(ids: readonly string[] | "all"): void;
  setSuggesting(on: boolean): void;
  appendHtml(html: string): void;
  undo(): void;
  redo(): void;
}

interface Options {
  store: MailStore;
  draft: DraftState;
  ownerName: string;
  now: () => number;
  proposals?: ProposalRegistry;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The agent's text in `bodyHtml` as tracked changes against the owner's text before it, or null when nothing differs. */
function proposalRedline(proposal: DraftProposal, bodyHtml: string, now: () => number): ComposeBody | null {
  if (!bodyHtml) return null;
  const fresh = ComposeBody.fromDraftHtml(proposal.original ? textToBodyHtml(proposal.original) : "", iso(now()));
  fresh.proposeRewrite(bodyHtml, { author: ASSISTANT_AUTHOR, date: iso(proposal.createdAt || now()) });
  return fresh.pendingCount() > 0 ? fresh : null;
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** The body a composer opens with: the live session, or the stored HTML, or an agent proposal shown as a redline. */
function openInitialBody(localId: string, bodyHtml: string, now: () => number, proposals: ProposalRegistry | undefined): { body: ComposeBody; proposalId: string | null } {
  const opened = peekBody(localId, bodyHtml, iso(now()));
  const proposal = opened.reused ? undefined : proposals?.forDraft(localId);
  const redline = proposal && !opened.body.hasRedline() ? proposalRedline(proposal, bodyHtml, now) : null;
  return redline ? { body: redline, proposalId: proposal!.id } : { body: opened.body, proposalId: proposal?.id ?? null };
}

export function useComposeBody({ store, draft, ownerName, now, proposals }: Options): ComposeBodyApi {
  const localId = draft.localId;
  // Computed once, without side effects; the mount effect below records it in the live sessions.
  const [initial] = useState(() => openInitialBody(localId, draft.draft.bodyHtml, now, proposals));
  const bodyRef = useRef<ComposeBody>(initial.body);
  /** The proposal already shown (or deliberately not shown) in this composer. */
  const shownProposal = useRef<string | null>(initial.proposalId);
  const writtenRef = useRef(draft.draft.bodyHtml);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastSnapshotAt = useRef(0);
  const [renderKey, setRenderKey] = useState(0);
  const [, setVersion] = useState(0);

  const body = bodyRef.current;

  const owner = useCallback((): EditAuthor => ({ author: ownerName, date: iso(now()) }), [ownerName, now]);

  /** Writes the body into the draft and refreshes the view. */
  const commit = useCallback((rerender: boolean) => {
    const current = bodyRef.current!;
    const out = current.draftBody();
    writtenRef.current = out.bodyHtml;
    remember(localId, current, out.bodyHtml);
    const stored = store.getSnapshot().drafts[localId]?.draft;
    if (stored && (stored.bodyHtml !== out.bodyHtml || stored.bodyText !== out.bodyText)) store.editDraft(localId, out);
    setVersion((v) => v + 1);
    if (rerender) setRenderKey((k) => k + 1);
    if (proposals && current.pendingCount() === 0) {
      const open = proposals.forDraft(localId);
      if (open) proposals.update(open.id, { status: "accepted" });
    }
  }, [localId, store, proposals]);

  const snapshot = useCallback((force: boolean) => {
    const at = now();
    if (!force && at - lastSnapshotAt.current < UNDO_COALESCE_MS) return;
    lastSnapshotAt.current = at;
    past.current = [...past.current, bodyRef.current!.draftBody().bodyHtml].slice(-MAX_UNDO);
    future.current = [];
  }, [now]);

  // The proposal above (if any) is written once on mount.
  useEffect(() => {
    if (bodyRef.current.draftBody().bodyHtml !== writtenRef.current) commit(true);
    else remember(localId, bodyRef.current, writtenRef.current);
  }, [commit, localId]);

  // Someone else wrote the body: show the difference as an assistant proposal.
  const incoming = draft.draft.bodyHtml;
  useEffect(() => {
    // Read the store, not the render: a write made by this hook may not have re-rendered yet.
    const latest = store.getSnapshot().drafts[localId]?.draft.bodyHtml;
    if (latest === undefined || latest === writtenRef.current) return;
    const current = bodyRef.current!;
    snapshot(true);
    if (hasTrackedMarkup(latest)) {
      const replaced = ComposeBody.fromDraftHtml(latest, iso(now()));
      replaced.setSuggesting(current.suggesting());
      bodyRef.current = replaced;
    } else {
      current.proposeRewrite(latest, { author: ASSISTANT_AUTHOR, date: iso(now()) });
    }
    commit(true);
  }, [incoming, commit, now, snapshot, store, localId]);

  // The agent wrote into the draft before this composer opened and recorded its proposal afterwards:
  // show its text as tracked changes, unless the owner has changed the text since.
  useEffect(() => {
    if (!proposals) return undefined;
    const check = () => {
      const proposal = proposals.forDraft(localId);
      if (!proposal || shownProposal.current === proposal.id) return;
      shownProposal.current = proposal.id;
      const current = bodyRef.current;
      if (current.hasRedline() || !sameText(current.finalText(), proposal.proposed)) return;
      const redline = proposalRedline(proposal, current.draftBody().bodyHtml, now);
      if (!redline) return;
      snapshot(true);
      redline.setSuggesting(current.suggesting());
      bodyRef.current = redline;
      commit(true);
    };
    check();
    return proposals.subscribe(check);
  }, [proposals, localId, commit, now, snapshot]);

  const restore = (html: string) => {
    const restored = ComposeBody.fromDraftHtml(html, iso(now()));
    restored.setSuggesting(bodyRef.current!.suggesting());
    bodyRef.current = restored;
    commit(true);
  };

  return {
    markup: body.markupHtml(),
    renderKey,
    changes: body.changes(),
    suggesting: body.suggesting(),
    finalText: body.finalText(),
    onUserInput(finalHtml) {
      const current = bodyRef.current!;
      snapshot(false);
      const wasRedline = current.hasRedline();
      if (!current.userEdit(finalHtml, owner())) return;
      // A redline is re-rendered so new marks appear; plain text is already what the editor shows.
      commit(wasRedline || current.hasRedline());
    },
    propose(html) {
      snapshot(true);
      bodyRef.current!.proposeRewrite(html, { author: ASSISTANT_AUTHOR, date: iso(now()) });
      commit(true);
    },
    accept(ids) {
      snapshot(true);
      bodyRef.current!.accept(ids);
      commit(true);
    },
    reject(ids) {
      snapshot(true);
      bodyRef.current!.reject(ids);
      commit(true);
    },
    setSuggesting(on) {
      bodyRef.current!.setSuggesting(on);
      commit(true);
    },
    appendHtml(html) {
      const current = bodyRef.current!;
      snapshot(true);
      if (current.userEdit(`${current.finalHtml()}${html}`, owner())) commit(true);
    },
    undo() {
      const previous = past.current[past.current.length - 1];
      if (previous === undefined) return;
      past.current = past.current.slice(0, -1);
      future.current = [...future.current, bodyRef.current!.draftBody().bodyHtml].slice(-MAX_UNDO);
      restore(previous);
    },
    redo() {
      const next = future.current[future.current.length - 1];
      if (next === undefined) return;
      future.current = future.current.slice(0, -1);
      past.current = [...past.current, bodyRef.current!.draftBody().bodyHtml].slice(-MAX_UNDO);
      restore(next);
    },
  };
}
