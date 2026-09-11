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

  return {
    async withPaths<T>(rawInput: {
      ownerType: "personal" | "organization";
      ownerId: string;
      paths: readonly string[];
      kind: "write" | "run";
    }, operation: () => Promise<T>): Promise<T> {
      const input = z.object({
        ownerType: z.enum(["personal", "organization"]),
        ownerId: OwnerIdSchema,
        paths: z.array(PathSchema).max(64),
        kind: z.enum(["write", "run"]),
      }).strict().safeParse({ ...rawInput, paths: [...rawInput.paths] });
      if (!input.success) throw new ProjectFenceError("invalid");

      const targets = input.data.paths
        .map((path) => resolveWritableFileApiPath(homePath, path))
        .filter((path): path is string => path !== null);
      if (targets.length === 0) return operation();

      const projects = z.array(ProjectSchema).max(MAX_OWNER_PROJECTS).safeParse(
        await options.listOwnerProjects(input.data.ownerType, input.data.ownerId),
      );
      if (!projects.success) throw new ProjectFenceError("unavailable");
      const matched = projects.data.filter((project) => {
        const root = resolveWithinHome(homePath, project.localPath);
        return root !== null && targets.some((target) => containsPath(root, target));
      }).sort((left, right) => left.id.localeCompare(right.id));
      const unique = matched.filter((project, index) => index === 0 || project.id !== matched[index - 1]!.id);
      if (unique.length > MAX_MATCHED_PROJECTS) throw new ProjectFenceError("capacity");

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
    },
  };
}
