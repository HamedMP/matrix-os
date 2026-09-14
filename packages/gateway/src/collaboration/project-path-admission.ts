import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { resolveWithinHome, resolveWritableFileApiPath } from "../path-security.js";
import {
  ProjectFenceError,
  type LegacyProjectOperationAdmission,
} from "./project-fence.js";

const MAX_MATCHED_PROJECTS = 32;
const MAX_OWNER_PROJECTS = 10_000;
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

function containsPath(root: string, target: string): boolean {
  const path = relative(resolve(root), target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
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
    maxPaths: number | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    const input = AdmissionContextSchema.safeParse({
      ownerType: rawInput.ownerType,
      ownerId: rawInput.ownerId,
      kind: rawInput.kind,
    });
    if (!input.success) throw new ProjectFenceError("invalid");
    if (!Array.isArray(rawInput.paths) || (maxPaths !== null && rawInput.paths.length > maxPaths)) {
      throw new ProjectFenceError("invalid");
    }

    const projects = z.array(ProjectSchema).max(MAX_OWNER_PROJECTS).safeParse(
      await options.listOwnerProjects(input.data.ownerType, input.data.ownerId),
    );
    if (!projects.success) throw new ProjectFenceError("unavailable");
    const projectRoots = projects.data.flatMap((project) => {
      const root = resolveWithinHome(homePath, project.localPath);
      return root === null ? [] : [{ project, root }];
    });
    const unique: typeof projects.data = [];
    for (const candidate of rawInput.paths) {
      const path = PathSchema.safeParse(candidate);
      if (!path.success) throw new ProjectFenceError("invalid");
      const target = resolveWritableFileApiPath(homePath, path.data);
      if (!target) continue;
      for (const entry of projectRoots) {
        if (!containsPath(entry.root, target)
          || unique.some((project) => project.id === entry.project.id)) continue;
        unique.push(entry.project);
        if (unique.length > MAX_MATCHED_PROJECTS) throw new ProjectFenceError("capacity");
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
      // Stored manifests are already resident in memory. Validate entries one
      // at a time so maintenance operations can drain every valid manifest
      // while the matched-project lock set remains bounded above.
      return admit(rawInput, null, operation);
    },
  };
}
