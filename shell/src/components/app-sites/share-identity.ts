/** Window title when known, else a readable form of the app slug. */
export function appDisplayName(appSlug: string, appName?: string): string {
  const name = appName?.trim();
  if (name) return name.slice(0, 200);
  return appSlug.replaceAll(/[-_]+/g, " ").replace(/^./, (first) => first.toUpperCase());
}

/** Avatar initial for "You · Owner"; never renders the raw identity. */
export function ownerInitial(identity: string | null | undefined): string {
  const first = identity?.trim().charAt(0);
  return first && /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : "Y";
}
