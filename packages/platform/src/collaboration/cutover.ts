import type { Kysely } from "kysely";
import type { CollaborationPlatformDatabase } from "./database.js";

export type CutoverPhase = "pending" | "inventoried" | "fenced" | "drained" | "staged" | "verified" | "active" | "blocked";

export interface CutoverCounts {
  scopes: number;
  grants: number;
  invitations: number;
}

export interface CutoverHome {
  inventory(input: CutoverHomeRequest): Promise<{
    scopeId: string; organizationId: string; authorityGeneration: number;
    counts: CutoverCounts; idsDigest: string; ceilingDigest: string;
    backupInventoryRef: string; nonOrganizationRecords: number;
  }>;
  freeze(input: CutoverHomeRequest): Promise<{ fenceEpoch: number; fenceDigest: string }>;
  drain(input: CutoverHomeRequest): Promise<{ remainingRuns: number; interruptedRuns: number }>;
  stage(input: CutoverHomeRequest): Promise<{ counts: CutoverCounts; idsDigest: string; ceilingDigest: string }>;
  verify(input: CutoverHomeRequest): Promise<{ counts: CutoverCounts; idsDigest: string; ceilingDigest: string; nonOrganizationRecords: number }>;
  activate(input: CutoverHomeRequest): Promise<{ authorityGeneration: number }>;
  rollbackCompatible(input: CutoverHomeRequest): Promise<{ authorityGeneration: number }>;
}

export interface CutoverHomeRequest {
  scopeId: string;
  ownerId: string;
  runtimeId: string;
  organizationId: string;
  expectedSourceGeneration: number;
  targetGeneration: number;
  idempotencyKey: string;
}

export interface CutoverJournal {
  scopeId: string;
  phase: CutoverPhase;
  resumePhase: CutoverPhase | null;
  blockReason: string | null;
  counts: CutoverCounts | null;
  idsDigest: string | null;
  ceilingDigest: string | null;
  backupRef: string;
  rollbackMode: "compatible_direct" | null;
}

export class PlatformCollaborationCutover {
  constructor(private readonly options: {
    db: Kysely<CollaborationPlatformDatabase>;
    resolveHome(input: { scopeId: string; runtimeId: string; ownerId: string }): Promise<
      { status: "ready"; home: CutoverHome } | { status: "offline" | "ambiguous" }
    >;
  }) {}

  async run(_scopeId: string, _input: { backupRef: string }): Promise<CutoverJournal> {
    throw new Error("T089 cutover coordinator is not implemented");
  }

  async resume(_scopeId: string): Promise<CutoverJournal> {
    throw new Error("T089 cutover recovery is not implemented");
  }

  async rollback(_scopeId: string, _mode: string): Promise<CutoverJournal> {
    throw new Error("T089 cutover rollback is not implemented");
  }

  async terminateLegacy(_input: { scopeId: string; noticeRef: string; backupRef: string; homeReceipt: string }): Promise<void> {
    throw new Error("T089 legacy disposition is not implemented");
  }
}
