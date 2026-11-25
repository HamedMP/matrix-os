/**
 * Recipient suggestions from addresses already seen in the mail cache.
 * Nothing is fetched: the book is built from thread summaries in the store.
 */
import {
  isValidMailAddress,
  normalizeMailAddress,
  type MailAddress,
  type ThreadSummary,
} from "../../../_shared/office-accounts/types/mail";

/** Addresses kept in the book; the most recently seen win. */
export const MAX_KNOWN_ADDRESSES = 2_000;
export const MAX_SUGGESTIONS = 8;
const MAX_QUERY_CHARS = 100;

/** Every valid address on a known thread, newest thread first, without the owner's own addresses. */
export function collectKnownAddresses(threads: Readonly<Record<string, ThreadSummary>>, ownAddresses: readonly string[]): MailAddress[] {
  const own = new Set(ownAddresses.map(normalizeMailAddress));
  const ordered = Object.values(threads).sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : 0));
  const book = new Map<string, MailAddress>();
  for (const thread of ordered) {
    for (const participant of thread.participants) {
      const address = normalizeMailAddress(participant.address ?? "");
      if (!isValidMailAddress(address) || own.has(address)) continue;
      const existing = book.get(address);
      if (existing) {
        if (!existing.name && participant.name) book.set(address, { name: participant.name, address });
        continue;
      }
      if (book.size >= MAX_KNOWN_ADDRESSES) return [...book.values()];
      book.set(address, participant.name ? { name: participant.name, address } : { address });
    }
  }
  return [...book.values()];
}

function rank(entry: MailAddress, query: string): number {
  const address = entry.address;
  if (address.startsWith(query)) return 0;
  const name = (entry.name ?? "").toLowerCase();
  if (name.startsWith(query)) return 1;
  if (name.split(/\s+/).some((word) => word.startsWith(query))) return 2;
  const [local, domain = ""] = address.split("@");
  if (local.split(/[._-]/).some((part) => part.startsWith(query))) return 3;
  if (domain.startsWith(query) || domain.split(".").some((part) => part.startsWith(query))) return 4;
  return -1;
}

/** Up to `limit` book entries that match `query`, best matches first, skipping `taken`. */
export function suggestAddresses(
  book: readonly MailAddress[],
  query: string,
  taken: readonly MailAddress[],
  limit = MAX_SUGGESTIONS,
): MailAddress[] {
  const q = query.trim().toLowerCase().slice(0, MAX_QUERY_CHARS);
  if (!q || limit <= 0) return [];
  const skip = new Set(taken.map((entry) => normalizeMailAddress(entry.address)));
  const buckets: MailAddress[][] = [[], [], [], [], []];
  for (const entry of book) {
    if (skip.has(entry.address)) continue;
    const score = rank(entry, q);
    if (score >= 0) buckets[score].push(entry);
  }
  return buckets.flat().slice(0, limit);
}
