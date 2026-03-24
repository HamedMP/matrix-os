const SAFE_SLUG = /^[a-z][a-z0-9_-]{0,62}$/;

export type AppSlug = string & { readonly __brand: "AppSlug" };
export type SafeName = string & { readonly __brand: "SafeName" };

export function parseAppSlug(s: string): AppSlug {
  if (!SAFE_SLUG.test(s)) throw new Error(`Invalid app slug: ${s}`);
  return s as AppSlug;
}

export function parseSafeName(s: string, label: string): SafeName {
  if (!SAFE_SLUG.test(s)) throw new Error(`Invalid ${label}: ${s}`);
  return s as SafeName;
}

export function isSafeName(s: string): s is SafeName {
  return SAFE_SLUG.test(s);
}

export interface TableDef {
  columns: Record<string, string>;
  indexes?: string[];
}

export type Comparable = string | number | boolean | null;

export type FilterOp = {
  $eq?: Comparable;
  $ne?: Comparable;
  $lt?: string | number;
  $lte?: string | number;
  $gt?: string | number;
  $gte?: string | number;
  $in?: Comparable[];
  $like?: string;
  $ilike?: string;
};

export type FilterValue = Comparable | FilterOp;
