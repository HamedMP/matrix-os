/**
 * Which revisions belong to an assistant card.
 *
 * A card keeps the revision ids its edit created. The document can split a
 * revision later: when the owner types inside an assistant insertion, the
 * part after the caret becomes a new revision with a new id, the same author
 * and the same date. A card therefore also claims the revisions with the
 * author and date of its own revisions, except the ones that already existed
 * when the card was made and the ones another card lists by id.
 */

import type { Revision } from "../../../../_shared/office-engine/index";

/** What identifies a card's revisions besides their ids. */
export interface CardLineage {
  /** `author|date` of each of the card's revisions. */
  keys: string[];
  /** Revisions with one of those keys that existed before the card: not the card's. */
  foreign: string[];
}

function keyOf(revision: Revision): string | null {
  return revision.date === null ? null : `${revision.author}|${revision.date}`;
}

/**
 * Records the lineage of a card from the document right after its edit.
 * Nothing has split yet, so every other revision with the same author and
 * date was there before and is not the card's.
 */
export function lineageOf(revisions: readonly Revision[], ids: readonly string[]): CardLineage {
  const own = new Set(ids);
  const keys = new Set<string>();
  for (const revision of revisions) {
    const key = keyOf(revision);
    if (own.has(revision.id) && key !== null) keys.add(key);
  }
  const foreign = revisions.filter((revision) => !own.has(revision.id) && keys.has(keyOf(revision) ?? "")).map((revision) => revision.id);
  return { keys: [...keys], foreign };
}

/** The card's revisions still pending: its own ids and the pieces split off them. */
export function cardRevisions(revisions: readonly Revision[], ids: readonly string[], lineage: CardLineage | undefined, claimed: ReadonlySet<string>): Revision[] {
  const own = new Set(ids);
  const keys = new Set(lineage?.keys ?? []);
  const foreign = new Set(lineage?.foreign ?? []);
  return revisions.filter((revision) => {
    if (own.has(revision.id)) return true;
    const key = keyOf(revision);
    return key !== null && keys.has(key) && !foreign.has(revision.id) && !claimed.has(revision.id);
  });
}

/**
 * The pending revisions that make up one listed change: its own ids, and the
 * split pieces in the same paragraph that no other listed change names.
 */
export function changeRevisions(pending: readonly Revision[], changeIds: readonly string[], blockId: string, listed: ReadonlySet<string>): string[] {
  const own = new Set(changeIds);
  return pending.filter((revision) => own.has(revision.id) || (!listed.has(revision.id) && revision.blockIds.includes(blockId))).map((revision) => revision.id);
}
