import type { ShareOrganization } from "./organization-identity";

/** `all`, `mine`, or `org:<organizationId>`. */
export type LauncherFilter = "all" | "mine" | `org:${string}`;

export interface LauncherFilterEntry {
  /** Set for apps shared from an organization (2689 directory item). */
  organizationId?: string | null;
  /** True for apps the owner built; built-ins and shared apps are not "mine". */
  mine: boolean;
}

export interface LauncherChip {
  filter: LauncherFilter;
  label: string;
  organization?: ShareOrganization;
  count?: number;
}

/** All apps · Mine · one chip per organization with at least one shared app. */
export function launcherFilterChips(entries: readonly LauncherFilterEntry[], organizations: readonly ShareOrganization[]): LauncherChip[] {
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.organizationId) counts.set(entry.organizationId, (counts.get(entry.organizationId) ?? 0) + 1);
  const orgChips = organizations
    .filter((organization) => counts.has(organization.organizationId))
    .map((organization): LauncherChip => ({ filter: `org:${organization.organizationId}`, label: organization.name, organization, count: counts.get(organization.organizationId) }));
  return [{ filter: "all", label: "All apps" }, { filter: "mine", label: "Mine" }, ...orgChips];
}

export function matchesLauncherFilter(entry: LauncherFilterEntry, filter: LauncherFilter): boolean {
  if (filter === "all") return true;
  if (filter === "mine") return entry.mine;
  return entry.organizationId === filter.slice(4);
}

/** A filter whose org chip disappeared (left org, share stopped) falls back to All apps. */
export function effectiveLauncherFilter(filter: LauncherFilter, chips: readonly LauncherChip[]): LauncherFilter {
  return chips.some((chip) => chip.filter === filter) ? filter : "all";
}

export function launcherFilterHint(filter: LauncherFilter, shownCount: number, chips: readonly LauncherChip[], allHint: string): string {
  if (filter === "all") return allHint;
  if (filter === "mine") return "Apps you made.";
  const organization = chips.find((chip) => chip.filter === filter)?.organization;
  return `${shownCount} ${shownCount === 1 ? "app" : "apps"} shared in ${organization?.name ?? "this organization"}.`;
}

/** Accessible tile name: "{App} — shared from {Org}[, new]". */
export function sharedTileLabel(name: string, organization: { name: string } | null | undefined, isNew = false): string {
  return organization ? `${name} — shared from ${organization.name}${isNew ? ", new" : ""}` : name;
}
