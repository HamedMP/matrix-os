/** "Name · email", then the email alone, then a short id: never a raw Clerk id when a name is known. */
export function memberLabel(
  member: { displayName?: string | undefined; emailAddress?: string | undefined } | undefined,
  actorId: string,
): string {
  if (member?.displayName && member.emailAddress) return `${member.displayName} · ${member.emailAddress}`;
  if (member?.displayName) return member.displayName;
  if (member?.emailAddress) return member.emailAddress;
  return actorId.length > 14 ? `${actorId.slice(0, 9)}…${actorId.slice(-4)}` : actorId;
}
