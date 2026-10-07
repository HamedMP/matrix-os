/** "Name · email", then the email alone, then a short id: never a raw Clerk id when a name is known. */
export function memberLabel(
  member: { displayName?: string | undefined; emailAddress?: string | undefined } | undefined,
  actorId: string,
): string {
  const displayName = member?.displayName === actorId ? undefined : member?.displayName;
  if (displayName && member?.emailAddress) return `${displayName} · ${member.emailAddress}`;
  if (displayName) return displayName;
  if (member?.emailAddress) return member.emailAddress;
  return actorId.length > 14 ? `${actorId.slice(0, 9)}…${actorId.slice(-4)}` : actorId;
}
