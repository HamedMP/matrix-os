// The Spaces filter (ENG-521): with many Preview Computers the list drowns out
// this device, the Main Computer and the Additional computers. Spaces can be
// narrowed by name and by kind, and Preview Computers wait under one fold.
// Pure, so the sidebar and its tests share one derivation.

/** What kind of machine a space is, for the filter's toggles. */
export type SpaceGroup = "this" | "main" | "additional" | "preview";
export const SPACE_GROUPS: readonly SpaceGroup[] = ["this", "main", "additional", "preview"];
export const SPACE_GROUP_LABEL: Record<SpaceGroup, string> = {
  this: "This device", main: "Main", additional: "Additional", preview: "Previews",
};
/** A typed filter is bounded like a space name. */
export const SPACES_QUERY_MAX = 64;

export interface FilterableMachine {
  id: string;
  name: string;
  group: SpaceGroup;
}

export interface SpacesFilterResult<T extends FilterableMachine> {
  /** Machines listed in the main list. */
  shown: T[];
  /** Preview Computers, listed under their own fold. */
  previews: T[];
  /** For a machine shown only because some of its projects match: just those projects. */
  projectsOf(machineId: string): ((space: string) => boolean) | null;
}

const normalize = (text: string) => text.trim().toLowerCase().slice(0, SPACES_QUERY_MAX);

/**
 * The machines to list for a typed filter and the kinds switched off. A
 * machine matches by its name, or by any of its projects' names; then only the
 * matching projects are listed under it.
 */
export function filterSpaces<T extends FilterableMachine>(
  machines: readonly T[],
  query: string,
  hidden: readonly SpaceGroup[],
  projects: (machineId: string) => readonly string[],
): SpacesFilterResult<T> {
  const text = normalize(query);
  const off = new Set(hidden);
  const narrowed = new Map<string, (space: string) => boolean>();
  const kept = machines.filter((machine) => {
    if (off.has(machine.group)) return false;
    if (!text || machine.name.toLowerCase().includes(text)) return true;
    const match = (space: string) => space.toLowerCase().includes(text);
    if (!projects(machine.id).some(match)) return false;
    narrowed.set(machine.id, match);
    return true;
  });
  return {
    shown: kept.filter((machine) => machine.group !== "preview"),
    previews: kept.filter((machine) => machine.group === "preview"),
    projectsOf: (machineId) => narrowed.get(machineId) ?? null,
  };
}
