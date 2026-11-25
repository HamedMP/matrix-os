/** Pure helpers behind the event composer's guest field and footer. */
import { isValidMailAddress } from "../../../_shared/office-accounts/types/addresses";
import type { DraftState } from "../model/drafts";

const SEPARATORS = /[\s,;]+/;

/** Splits typed or pasted text into addresses; `invalid` holds the pieces that are not addresses. */
export function parseAddressInput(text: string): { valid: string[]; invalid: string[] } {
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const piece of text.split(SEPARATORS)) {
    const trimmed = piece.replace(/^<|>$/g, "").trim().toLowerCase();
    if (!trimmed) continue;
    if (isValidMailAddress(trimmed)) valid.add(trimmed);
    else invalid.push(piece.trim());
  }
  return { valid: [...valid], invalid };
}

/** Everyone a save would notify: current guests plus, when editing, guests that were removed. */
export function inviteRecipients(draftState: DraftState): string[] {
  const addresses = [...draftState.draft.attendees, ...(draftState.original?.attendees ?? [])].map((attendee) => attendee.address.toLowerCase());
  return [...new Set(addresses)];
}
