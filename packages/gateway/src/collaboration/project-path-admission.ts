import { dirname, resolve } from "node:path";
import { z } from "zod/v4";
import { resolveWithinHome, resolveWritableFileApiPath } from "../_shared/path-security.js";
import {
  ProjectFenceError,
  type LegacyProjectOperationAdmission,
} from "./project-fence.js";

const MAX_MATCHED_PROJECTS = 32;
const MAX_OWNER_PROJECTS = 10_000;
const PATHS_PER_EVENT_LOOP_TURN = 256;
const PathSchema = z.string().min(1).max(4_096);
const OwnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const AdmissionContextSchema = z.object({
  ownerType: z.enum(["personal", "organization"]),
  ownerId: OwnerIdSchema,
  kind: z.enum(["write", "run"]),
}).strict();
const ProjectSchema = z.object({
  id: z.string().regex(/^proj_[A-Za-z0-9_-]{1,128}$/),
  localPath: z.string().min(1).max(4_096),
}).strict();

export interface LegacyProjectPathAdmission {
  withPaths<T>(input: {
    ownerType: "personal" | "organization";
    ownerId: string;
    paths: readonly string[];
    kind: "write" | "run";
  }, operation: () => Promise<T>): Promise<T>;
  withStoredPaths<T>(input: {
    ownerType: "personal" | "organization";
    ownerId: string;
    paths: readonly string[];
    kind: "write" | "run";
  }, operation: () => Promise<T>): Promise<T>;
}

export function createLegacyProjectPathAdmission(options: {
  homePath: string;
  listOwnerProjects(ownerType: "personal" | "organization", ownerId: string): Promise<Array<{
    id: string;
    localPath: string;
  }>>;
  projectOperationAdmission: LegacyProjectOperationAdmission;
}): LegacyProjectPathAdmission {
  const homePath = resolve(options.homePath);

  async function admit<T>(
    rawInput: {
      ownerType: "personal" | "organization";
      ownerId: string;
      paths: readonly string[];
      kind: "write" | "run";
    },
    maxPaths: number | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const input = AdmissionContextSchema.safeParse({
      ownerType: rawInput.ownerType,
      ownerId: rawInput.ownerId,
      kind: rawInput.kind,
    });
    if (!input.success) throw new ProjectFenceError("invalid");
    if (!Array.isArray(rawInput.paths) || (maxPaths !== undefined && rawInput.paths.length > maxPaths)) {
      throw new ProjectFenceError("invalid");
    }

    const projects = z.array(ProjectSchema).max(MAX_OWNER_PROJECTS).safeParse(
      await options.listOwnerProjects(input.data.ownerType, input.data.ownerId),
    );
    if (!projects.success) throw new ProjectFenceError("unavailable");
    // At most MAX_OWNER_PROJECTS keys and values are inserted. Ancestor lookup
    // avoids multiplying every maintenance path by the full project inventory.
    const projectsByRoot = new Map<string, typeof projects.data>();
    for (const project of projects.data) {
      const root = resolveWithinHome(homePath, project.localPath);
      if (root === null) continue;
      const entries = projectsByRoot.get(root);
      if (entries) entries.push(project);
      else projectsByRoot.set(root, [project]);
    }
    const unique: typeof projects.data = [];
    for (const [index, candidate] of rawInput.paths.entries()) {
      if (index > 0 && index % PATHS_PER_EVENT_LOOP_TURN === 0) {
        await new Promise<void>((complete) => setImmediate(complete));
      }
      const path = PathSchema.safeParse(candidate);
      if (!path.success) throw new ProjectFenceError("invalid");
      const target = resolveWritableFileApiPath(homePath, path.data);
      if (!target) continue;
      let ancestor = target;
      for (;;) {
        for (const project of projectsByRoot.get(ancestor) ?? []) {
          if (unique.some((entry) => entry.id === project.id)) continue;
          unique.push(project);
          if (unique.length > MAX_MATCHED_PROJECTS) throw new ProjectFenceError("capacity");
        }
        if (ancestor === homePath) break;
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    unique.sort((left, right) => left.id.localeCompare(right.id));
    if (unique.length === 0) return operation();

    const run = async (index: number): Promise<T> => {
      const project = unique[index];
      if (!project) return operation();
      return options.projectOperationAdmission.withLegacyAdmission({
        ownerType: input.data.ownerType,
        ownerId: input.data.ownerId,
        projectId: project.id,
        kind: input.data.kind,
      }, () => run(index + 1));
    };
    return run(0);
  }

  return {
    withPaths<T>(rawInput: {
      ownerType: "personal" | "organization";
      ownerId: string;
      paths: readonly string[];
      kind: "write" | "run";
    }, operation: () => Promise<T>): Promise<T> {
      return admit(rawInput, 64, operation);
    },
    withStoredPaths<T>(rawInput: {
      ownerType: "personal" | "organization";
      ownerId: string;
      paths: readonly string[];
      kind: "write" | "run";
    }, operation: () => Promise<T>): Promise<T> {
      // Stored maintenance manifests must remain fully recoverable regardless
      // of entry count. admit() streams the existing array without retaining
      // per-path state, yields every PATHS_PER_EVENT_LOOP_TURN entries, and
      // keeps both the project inventory and matched-project set capped.
      return admit(rawInput, undefined, operation);
    },
  };
}
