export type RailSortMode = "lastUpdated" | "manual";
export interface RailOrderPreference {mode: RailSortMode; chatIds: string[]; projectIds: string[]}
export const DEFAULT_RAIL_ORDER: RailOrderPreference = {mode:"lastUpdated", chatIds:[], projectIds:[]};
const MAX_IDS = 1000;
function boundedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !id || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === MAX_IDS) break;
  }
  return ids;
}
export function parseRailOrderPreference(raw: string | null): RailOrderPreference {
  if (!raw || raw.length > 600_000) return DEFAULT_RAIL_ORDER;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("mode" in value) || (value.mode !== "manual" && value.mode !== "lastUpdated")) return DEFAULT_RAIL_ORDER;
    return {mode:value.mode, chatIds:boundedIds("chatIds" in value ? value.chatIds : []), projectIds:boundedIds("projectIds" in value ? value.projectIds : [])};
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[work] Rail preference read failed:", error instanceof Error ? error.name : "UnknownError");
    return DEFAULT_RAIL_ORDER;
  }
}
interface Orderable {id: string; updatedAt?: string; createdAt?: string}
export function orderRailItems<T extends Orderable>(items: readonly T[], mode: RailSortMode, ids: readonly string[]): T[] {
  const ranks = new Map(ids.slice(0,MAX_IDS).map((id,index)=>[id,index]));
  return [...items].sort((a,b)=> {
    if (mode === "lastUpdated") return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id);
    const rank = (ranks.get(a.id) ?? MAX_IDS) - (ranks.get(b.id) ?? MAX_IDS);
    return rank || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
  });
}
export function moveRailItem(ids: readonly string[], source: string, target: string): string[] {
  const next = boundedIds(ids);
  const from = next.indexOf(source);
  const to = next.indexOf(target);
  if (from < 0 || to < 0 || from === to) return next;
  next.splice(from,1);
  next.splice(to,0,source);
  return next;
}
