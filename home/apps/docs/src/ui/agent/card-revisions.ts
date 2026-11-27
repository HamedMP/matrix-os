/**
 * Which revisions belong to an assistant card, and what its status is.
 *
 * A card keeps the revision ids its edit created. The document can split a
 * revision later: when the owner types inside an assistant insertion (or
 * presses Enter in it), the part after the caret becomes a new revision with
 * a new id, the same kind, author and date. The store compares the pending
 * revisions before and after each change and ties every such piece to the
 * original revision it was split off, and so to that revision's card and
 * listed change (`splitPieces`). Author and date alone cannot tell two cards
 * apart, and the paragraph cannot tell two changes apart: requests finished
 * in the same minute share both, and one card can edit a paragraph twice.
 */

import type { ChangeSummaryItem } from "../../agent/index";
import type { Revision } from "../../../../_shared/office-engine/index";

/** Most split pieces a card keeps; the oldest are dropped first. */
const MAX_CARD_PIECES = 500;

/** True when `piece` can be the part the document split off `parent` (`parent` before, `current` after the change). */
function splitOff(parent: Revision, current: Revision, piece: Revision): boolean {
  return (
    parent.kind === piece.kind &&
    parent.author === piece.author &&
    parent.date === piece.date &&
    parent.storyId === piece.storyId &&
    current.text.length + piece.text.length <= parent.text.length &&
    parent.text.includes(piece.text)
  );
}

/** Where a revision comes from: the card that owns it, and the original revision of that card it is (part of). */
export interface Lineage {
  card: string;
  origin: string;
}

/**
 * The revisions that a change split off revisions a card owns, with their
 * lineage: new in `after`, and part of a revision of `before` that is still
 * there but lost the piece's text. A piece split off a piece keeps the
 * original revision of the first. A piece whose possible parents come from
 * different original revisions, or from none a card owns, is left out.
 */
export function splitPieces(before: readonly Revision[], after: readonly Revision[], lineageOf: (revisionId: string) => Lineage | undefined): Map<string, Lineage> {
  const previous = new Map(before.map((revision) => [revision.id, revision]));
  const current = new Map(after.map((revision) => [revision.id, revision]));
  const pieces = new Map<string, Lineage>();
  for (const piece of after) {
    if (previous.has(piece.id) || piece.text === "") continue;
    const origins = new Map<string | undefined, Lineage | undefined>();
    for (const parent of before) {
      const now = current.get(parent.id);
      if (now === undefined || !splitOff(parent, now, piece)) continue;
      const lineage = lineageOf(parent.id);
      origins.set(lineage?.origin, lineage);
    }
    const [lineage] = origins.values();
    if (origins.size === 1 && lineage !== undefined) pieces.set(piece.id, lineage);
  }
  return pieces;
}

/** The card with the pieces `found` ties to it added to its own, by original revision (the same object when there are none). */
export function withPieces<T extends { id: string; pieces?: Readonly<Record<string, string>> }>(card: T, found: ReadonlyMap<string, Lineage>): T {
  const known = card.pieces ?? {};
  const added = [...found].filter(([id, lineage]) => lineage.card === card.id && !Object.hasOwn(known, id)).map(([id, lineage]) => [id, lineage.origin] as const);
  if (added.length === 0) return card;
  return { ...card, pieces: Object.fromEntries([...Object.entries(known), ...added].slice(-MAX_CARD_PIECES)) };
}

/** The card's revisions still pending: its own ids and the pieces split off them that no other card names as its own. */
export function cardRevisions(revisions: readonly Revision[], ids: readonly string[], pieces: Readonly<Record<string, string>>, claimed: ReadonlySet<string>): Revision[] {
  const own = new Set(ids);
  return revisions.filter((revision) => own.has(revision.id) || (Object.hasOwn(pieces, revision.id) && !claimed.has(revision.id)));
}

/**
 * The pending revisions of the card (`pending`) that make up one listed
 * change: its own ids, and the pieces split off them (`pieces` maps a piece
 * to its original revision). A piece of another change of the same paragraph
 * is never part of it.
 */
export function changeRevisions(pending: readonly Revision[], changeIds: readonly string[], pieces: Readonly<Record<string, string>>): string[] {
  const own = new Set(changeIds);
  return pending.filter((revision) => own.has(revision.id) || (Object.hasOwn(pieces, revision.id) && own.has(pieces[revision.id] as string))).map((revision) => revision.id);
}

// ---------------------------------------------------------------- outcomes

/** `resolved`: nothing is pending, and the changes were resolved outside the card (for example in Review). */
export type CardStatus = "proposed" | "accepted" | "rejected" | "mixed" | "resolved";

export type ChangeOutcome = "accepted" | "rejected";

/** What a card shows, derived from the document as it is now. */
export interface CardView {
  status: CardStatus;
  /** Revisions of the card still pending. */
  pending: number;
  /** Changes the owner accepted or rejected from the card that are still resolved. */
  accepted: number;
  rejected: number;
  /** Changes resolved elsewhere, or whose outcome the card no longer knows after undo and redo. */
  elsewhere: number;
}

/** The key of the one unit of a card that lists no changes but has revisions. */
export const WHOLE_CARD = "*";

/** The unit of resolution: one listed change, keyed by its revision ids. */
export function changeKey(change: ChangeSummaryItem): string {
  return change.revisionIds.join(",");
}

/** A card's units: its listed changes, or the whole card when it lists none. */
export function unitKeys(card: { changes: readonly ChangeSummaryItem[]; revisionIds: readonly string[] }): string[] {
  if (card.changes.length > 0) return card.changes.map(changeKey);
  return card.revisionIds.length > 0 ? [WHOLE_CARD] : [];
}

/**
 * The card's status from its units, the ones still pending (`open`), and the
 * outcomes recorded when the owner resolved units from the card. A recorded
 * outcome counts only while its unit stays resolved.
 */
export function deriveCardView(units: readonly string[], open: ReadonlySet<string>, resolutions: Readonly<Record<string, ChangeOutcome>>, pending: number): CardView {
  let accepted = 0;
  let rejected = 0;
  let elsewhere = 0;
  for (const key of units) {
    if (open.has(key)) continue;
    const outcome = resolutions[key];
    if (outcome === "accepted") accepted++;
    else if (outcome === "rejected") rejected++;
    else elsewhere++;
  }
  const kinds = [accepted, rejected, elsewhere].filter((count) => count > 0).length;
  let status: CardStatus;
  if (open.size > 0 || kinds === 0) status = "proposed";
  else if (kinds > 1) status = "mixed";
  else if (accepted > 0) status = "accepted";
  else if (rejected > 0) status = "rejected";
  else status = "resolved";
  return { status, pending, accepted, rejected, elsewhere };
}

/** The recorded outcomes without those whose unit is pending again; the same object when none is. */
export function withoutReopened(resolutions: Readonly<Record<string, ChangeOutcome>>, open: ReadonlySet<string>): Readonly<Record<string, ChangeOutcome>> {
  const entries = Object.entries(resolutions);
  const kept = entries.filter(([key]) => !open.has(key));
  return kept.length === entries.length ? resolutions : Object.fromEntries(kept);
}
