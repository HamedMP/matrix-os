import { relative, resolve, sep } from "node:path";
import type { SyncMapping } from "@matrix-os/contracts/sync";

export interface ScopedSyncMapping {
  profile: string;
  ownerId: string;
  runtimeSlot: string;
  mapping: SyncMapping;
}

export interface MappingOverlapConflict {
  code: "local_overlap" | "remote_overlap";
  candidateMappingId: string;
  existingMappingId: string;
  existingProfile: string;
  requiredParentExclusion?: string;
}

function normalizedLocalPath(path: string, caseSensitive: boolean): string {
  const normalized = resolve(path).normalize("NFC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

function relation(
  left: string,
  right: string,
  separator: string,
): "equal" | "left_parent" | "right_parent" | "distinct" {
  if (left === right) return "equal";
  if (left === "") return "left_parent";
  if (right === "") return "right_parent";
  if (right.startsWith(left.endsWith(separator) ? left : `${left}${separator}`)) {
    return "left_parent";
  }
  if (left.startsWith(right.endsWith(separator) ? right : `${right}${separator}`)) {
    return "right_parent";
  }
  return "distinct";
}

function hasExactExclusion(mapping: SyncMapping, subtree: string): boolean {
  const normalized = subtree.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return mapping.excludes.some((entry) => (
    entry.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "") === normalized
  ));
}

function localRequiredExclusion(parentRoot: string, childRoot: string): string {
  return `${relative(parentRoot, childRoot).replaceAll(sep, "/")}/`;
}

function remoteRequiredExclusion(parent: string, child: string): string {
  const relativePrefix = parent === "" ? child : child.slice(parent.length + 1);
  return `${relativePrefix}/`;
}

export async function planMappingOverlaps(input: {
  candidate: ScopedSyncMapping;
  existing: ScopedSyncMapping[];
  realpath: (path: string) => Promise<string>;
  caseSensitive: boolean;
}): Promise<{ ok: boolean; conflicts: MappingOverlapConflict[] }> {
  if (!input.candidate.mapping.enabled) {
    return { ok: true, conflicts: [] };
  }
  const candidateRealRoot = await input.realpath(input.candidate.mapping.localRoot);
  const candidateRoot = normalizedLocalPath(candidateRealRoot, input.caseSensitive);
  const conflicts: MappingOverlapConflict[] = [];

  for (const existing of input.existing) {
    if (!existing.mapping.enabled || existing.mapping.id === input.candidate.mapping.id) {
      continue;
    }
    const existingRealRoot = await input.realpath(existing.mapping.localRoot);
    const existingRoot = normalizedLocalPath(existingRealRoot, input.caseSensitive);
    const localRelation = relation(existingRoot, candidateRoot, sep);
    if (localRelation !== "distinct") {
      let allowed = false;
      let requiredParentExclusion: string | undefined;
      if (localRelation === "left_parent") {
        requiredParentExclusion = localRequiredExclusion(existingRealRoot, candidateRealRoot);
        allowed = hasExactExclusion(existing.mapping, requiredParentExclusion);
      } else if (localRelation === "right_parent") {
        requiredParentExclusion = localRequiredExclusion(candidateRealRoot, existingRealRoot);
        allowed = hasExactExclusion(input.candidate.mapping, requiredParentExclusion);
      }
      if (!allowed) {
        conflicts.push({
          code: "local_overlap",
          candidateMappingId: input.candidate.mapping.id,
          existingMappingId: existing.mapping.id,
          existingProfile: existing.profile,
          ...(requiredParentExclusion ? { requiredParentExclusion } : {}),
        });
      }
    }

    const sameRemoteScope = existing.ownerId === input.candidate.ownerId
      && existing.runtimeSlot === input.candidate.runtimeSlot;
    if (!sameRemoteScope) continue;
    const remoteRelation = relation(
      existing.mapping.remotePrefix,
      input.candidate.mapping.remotePrefix,
      "/",
    );
    if (remoteRelation === "distinct") continue;
    let allowed = false;
    let requiredParentExclusion: string | undefined;
    if (remoteRelation === "left_parent") {
      requiredParentExclusion = remoteRequiredExclusion(
        existing.mapping.remotePrefix,
        input.candidate.mapping.remotePrefix,
      );
      allowed = hasExactExclusion(existing.mapping, requiredParentExclusion);
    } else if (remoteRelation === "right_parent") {
      requiredParentExclusion = remoteRequiredExclusion(
        input.candidate.mapping.remotePrefix,
        existing.mapping.remotePrefix,
      );
      allowed = hasExactExclusion(input.candidate.mapping, requiredParentExclusion);
    }
    if (!allowed) {
      conflicts.push({
        code: "remote_overlap",
        candidateMappingId: input.candidate.mapping.id,
        existingMappingId: existing.mapping.id,
        existingProfile: existing.profile,
        ...(requiredParentExclusion ? { requiredParentExclusion } : {}),
      });
    }
  }

  return { ok: conflicts.length === 0, conflicts };
}
