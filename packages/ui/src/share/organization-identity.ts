/** Org avatar colours: dark zinc first (Finna in the design), then distinct hues with white-text contrast ≥4.5:1. */
const ORGANIZATION_COLORS = ["#18181B", "#2563EB", "#C2410C", "#15803D", "#7C3AED", "#BE185D", "#0E7490", "#A16207"] as const;

/** Stable colour for an organization; the same org looks the same in Share and the launcher. */
export function organizationColor(organizationId: string): string {
  let hash = 0;
  for (let index = 0; index < organizationId.length; index += 1) hash = (hash * 31 + organizationId.charCodeAt(index)) >>> 0;
  return ORGANIZATION_COLORS[hash % ORGANIZATION_COLORS.length]!;
}

export function organizationInitial(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export interface ShareOrganization {
  organizationId: string;
  name: string;
  memberCount: number;
}

export function membersLabel(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}
