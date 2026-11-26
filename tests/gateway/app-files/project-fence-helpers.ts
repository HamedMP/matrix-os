import { appFileFenceTarget } from "../../../packages/gateway/src/app-files/paths";
import { ProjectFenceError } from "../../../packages/gateway/src/collaboration/project-fence";
import {
  createLegacyProjectPathAdmission, type LegacyProjectPathAdmission,
} from "../../../packages/gateway/src/collaboration/project-path-admission";

type FenceCode = ConstructorParameters<typeof ProjectFenceError>[0];

export interface TestProject {
  id: string;
  /** Home-relative project root. */
  localPath: string;
  ownerId: string;
  /** What the collaboration fence answers for an owner write; `null` admits it. */
  refusal: FenceCode | null;
}

export interface TestProjectAdmission {
  admission: LegacyProjectPathAdmission;
  /** `enter:<project>` and `leave:<project>` in the order they happened. */
  events: string[];
  /** Admissions held right now. */
  held(): number;
  failInventory: boolean;
}

/**
 * The production path admission over an in-memory project inventory and
 * fence, matching paths as the app file bridge does. Only the collaboration
 * database is replaced; path matching, owner scoping and nesting are the real code.
 */
export function createTestProjectAdmission(homePath: string, projects: readonly TestProject[]): TestProjectAdmission {
  const events: string[] = [];
  let held = 0;
  const state: TestProjectAdmission = {
    events,
    held: () => held,
    failInventory: false,
    admission: createLegacyProjectPathAdmission({
      homePath,
      // The resolver the gateway gives the app file bridge.
      resolveTarget: appFileFenceTarget,
      listOwnerProjects: async (_ownerType, ownerId) => {
        if (state.failInventory) throw new Error("inventory offline");
        return projects.filter((project) => project.ownerId === ownerId).map(({ id, localPath }) => ({ id, localPath }));
      },
      projectOperationAdmission: {
        async withLegacyAdmission(input, operation) {
          const project = projects.find((candidate) => candidate.id === input.projectId && candidate.ownerId === input.ownerId);
          if (!project) throw new ProjectFenceError("not_found");
          if (project.refusal) throw new ProjectFenceError(project.refusal);
          events.push(`enter:${project.id}`);
          held++;
          try { return await operation(); }
          finally { held--; events.push(`leave:${project.id}`); }
        },
      },
    }),
  };
  return state;
}
