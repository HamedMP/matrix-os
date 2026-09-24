/** S18: adapt the owner-home cutover result to the platform journal's frozen inventory. */
import type { CutoverCounts, CutoverHome, CutoverHomeRequest } from "./cutover.js";

export interface FlatHomeCutoverResult {
  scopeId: string;
  organizationId: string;
  phase: string;
  authorityGeneration: number;
  legacyCount: number;
  grantCount: number;
  invitationCount: number;
  nonOrganizationCount: number;
  ceilingDigest: string;
  idsDigest: string;
  backupInventoryRef: string;
  fenceEpoch: number | null;
  fenceDigest: string | null;
  interrupted?: number;
}

export interface FlatHomeCutoverClient {
  inventory(key: CutoverHomeRequest): Promise<FlatHomeCutoverResult>;
  freeze(key: CutoverHomeRequest): Promise<FlatHomeCutoverResult>;
  drain(key: CutoverHomeRequest, interrupt: () => Promise<{ interrupted: number; remaining: number }>): Promise<FlatHomeCutoverResult>;
  stage(key: CutoverHomeRequest): Promise<FlatHomeCutoverResult>;
  verify(key: CutoverHomeRequest): Promise<FlatHomeCutoverResult>;
  activate(key: CutoverHomeRequest): Promise<FlatHomeCutoverResult>;
  rollbackCompatible(key: CutoverHomeRequest, proof: { compatibleDirectBuild: true }): Promise<FlatHomeCutoverResult>;
  disable(key: CutoverHomeRequest): Promise<FlatHomeCutoverResult>;
}

const DIGEST = /^[a-f0-9]{64}$/;
const MAX_COUNT = 1_000_000;

function verifyBinding(result: FlatHomeCutoverResult, key: CutoverHomeRequest, phase: string): void {
  if (result.scopeId !== key.scopeId || result.organizationId !== key.organizationId || result.phase !== phase) {
    throw new Error("Owner-home cutover result changed scope, organization or phase");
  }
}

function counts(result: FlatHomeCutoverResult): CutoverCounts {
  const values = [result.legacyCount, result.grantCount, result.invitationCount, result.nonOrganizationCount];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT)
    || result.legacyCount + result.grantCount > MAX_COUNT) {
    throw new Error("Owner-home cutover counts are invalid");
  }
  // Legacy roles become shadow grants at activation; both are counted against
  // the immutable grant total. A distinct scope count cannot be inferred from
  // the flat home result because every home operation is scoped to one UUID.
  return { scopes: 1, grants: result.legacyCount + result.grantCount, invitations: result.invitationCount };
}

function snapshot(result: FlatHomeCutoverResult) {
  if (!DIGEST.test(result.idsDigest) || !DIGEST.test(result.ceilingDigest)) {
    throw new Error("Owner-home cutover digests are invalid");
  }
  return { counts: counts(result), idsDigest: result.idsDigest, ceilingDigest: result.ceilingDigest };
}

/** The scoped drain callback belongs to the owner runtime; it is never sent across the relay. */
export function createGatewayCutoverHomeAdapter(options: {
  client: FlatHomeCutoverClient;
  /** In-process homes inject the canonical drain here; the remote home route owns it locally. */
  drainRuns?(key: CutoverHomeRequest): Promise<{ interrupted: number; remaining: number }>;
}): CutoverHome {
  const { client } = options;
  return {
    async inventory(key) {
      const result = await client.inventory(key);
      verifyBinding(result, key, "inventoried");
      return {
        scopeId: result.scopeId, organizationId: result.organizationId,
        authorityGeneration: result.authorityGeneration, ...snapshot(result),
        backupInventoryRef: result.backupInventoryRef,
        nonOrganizationRecords: result.nonOrganizationCount,
      };
    },
    async freeze(key) {
      const result = await client.freeze(key);
      verifyBinding(result, key, "fenced");
      if (result.fenceEpoch === null || result.fenceDigest === null || !DIGEST.test(result.fenceDigest)) {
        throw new Error("Owner-home cutover fence is incomplete");
      }
      return { fenceEpoch: result.fenceEpoch, fenceDigest: result.fenceDigest };
    },
    async drain(key) {
      const result = await client.drain(key, () => {
        if (!options.drainRuns) throw new Error("Local cutover drain is unavailable");
        return options.drainRuns(key);
      });
      verifyBinding(result, key, "drained");
      if (result.interrupted === undefined || !Number.isSafeInteger(result.interrupted) || result.interrupted < 0) {
        throw new Error("Owner-home cutover drain is incomplete");
      }
      // The gateway only returns `drained` after its canonical callback
      // reports zero active runs. A missing or nonzero count rejects there.
      return { remainingRuns: 0, interruptedRuns: result.interrupted };
    },
    async stage(key) {
      const result = await client.stage(key);
      verifyBinding(result, key, "staged");
      return snapshot(result);
    },
    async verify(key) {
      const result = await client.verify(key);
      verifyBinding(result, key, "verified");
      return { ...snapshot(result), nonOrganizationRecords: result.nonOrganizationCount };
    },
    async activate(key) {
      const result = await client.activate(key);
      verifyBinding(result, key, "active");
      return { authorityGeneration: result.authorityGeneration };
    },
    async rollbackCompatible(key) {
      const result = await client.rollbackCompatible(key, { compatibleDirectBuild: true });
      verifyBinding(result, key, "rolled_back");
      return { authorityGeneration: result.authorityGeneration };
    },
    async disable(key) {
      const result = await client.disable(key);
      verifyBinding(result, key, "blocked");
      return { fenced: true };
    },
  };
}
