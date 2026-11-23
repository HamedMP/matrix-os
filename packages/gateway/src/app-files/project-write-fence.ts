import { ProjectFenceError } from "../collaboration/project-fence.js";
import type { LegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";

/** Why an owner write was not admitted. `refused`: the project is shared or mid-transition. */
export type ProjectWriteRefusal = "refused" | "unavailable";

/** An owner write the collaboration fence did not admit. The reason is for logs only. */
export class ProjectWriteRefusedError extends Error {
  constructor(readonly refusal: ProjectWriteRefusal, readonly reason: string) {
    super(`Project write ${refusal}`);
    this.name = "ProjectWriteRefusedError";
  }
}

/** Runs a write to home-relative `paths` once the collaboration fence admits it. */
export type ProjectWriteGuard = <T>(paths: readonly string[], operation: () => Promise<T>) => Promise<T>;

/** Admits everything: the gateway has no collaboration database. */
export const unguardedProjectWrite: ProjectWriteGuard = (_paths, operation) => operation();

/** A single-owner gateway knows its owner by at most a few identities. */
const MAX_OWNER_IDS = 4;
/** Same split as the owner file routes: these mean "use the shared project route". */
const REFUSED_CODES: ReadonlySet<string> = new Set(["fenced", "scope_required", "conflict", "not_found"]);

function refusalFor(error: unknown): ProjectWriteRefusedError {
  if (error instanceof ProjectFenceError) {
    return new ProjectWriteRefusedError(REFUSED_CODES.has(error.code) ? "refused" : "unavailable", error.code);
  }
  return new ProjectWriteRefusedError("unavailable", error instanceof Error ? error.name : "UnknownError");
}

/**
 * The write fence every owner file route applies, for app file writes and
 * document service saves. A path inside a managed project is written only
 * while that project admits a legacy owner write, and the admission is held
 * until the write settles. Call it inside the owner file mutation guard, as
 * the owner file routes do. `ownerIds` are the identities the owner's
 * projects may be recorded under; every one of them must admit the write.
 */
export function createProjectWriteGuard(
  admission: LegacyProjectPathAdmission,
  ownerIds: readonly string[],
): ProjectWriteGuard {
  const owners = [...new Set(ownerIds)];
  return async <T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> => {
    if (owners.length === 0 || owners.length > MAX_OWNER_IDS) throw new ProjectWriteRefusedError("unavailable", "owner");
    // The operation's own result is kept apart from admission failures, so a
    // version conflict inside an admitted project stays a version conflict.
    const settled: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
    const admit = (index: number): Promise<void> => {
      const ownerId = owners[index];
      if (ownerId === undefined) {
        return operation().then(
          (value) => { settled.outcome = { ok: true, value }; },
          (error: unknown) => { settled.outcome = { ok: false, error }; },
        );
      }
      return admission.withPaths({ ownerType: "personal", ownerId, paths, kind: "write" }, () => admit(index + 1));
    };
    try {
      await admit(0);
    } catch (error: unknown) {
      if (settled.outcome === undefined) throw refusalFor(error);
      // The write settled; only releasing the admission failed.
      console.warn("[project-write-fence] admission release failed", error instanceof Error ? error.name : "UnknownError");
    }
    const { outcome } = settled;
    if (outcome === undefined) throw new ProjectWriteRefusedError("unavailable", "not admitted");
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  };
}
