/** "Name · email", then the email alone, then a short id: never a raw Clerk id when a name is known. */
export function memberLabel(
  member: { displayName?: string | undefined; email?: string | undefined } | undefined,
  actorId: string,
): string {
  if (member?.displayName && member.email) return `${member.displayName} · ${member.email}`;
  if (member?.displayName) return member.displayName;
  if (member?.email) return member.email;
  return actorId.length > 14 ? `${actorId.slice(0, 9)}…${actorId.slice(-4)}` : actorId;
}
