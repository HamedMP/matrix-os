/**
 * Shared stubs for exercising `constructOwnerCollaboration` as behavior.
 *
 * The startup extraction moved the surface composition out of this module, so the
 * wiring tests drive the real composition against these stubs and observe which
 * runtime surfaces it enables, and in what order, instead of grepping the source.
 */
import type { OwnerCollaborationStartupOptions } from "../../packages/gateway/src/startup/collaboration.js";

export const HARNESS_OWNER_ID = "user_startup_owner";

/** Every runtime surface the owner composition enables, recorded in call order. */
export interface EnabledSurfaces {
  order: string[];
  terminal?: Record<string, unknown>;
  resources?: { driver: { close(): void } };
  git?: Record<string, unknown>;
  project?: Record<string, unknown>;
}

/** A collaboration runtime that only records what the composition enables on it. */
export function recordingRuntime(surfaces: EnabledSurfaces) {
  return {
    enableSharedTerminal(input: Record<string, unknown>) {
      surfaces.order.push("terminal");
      surfaces.terminal = input;
    },
    enableSharedResources(input: { driver: { close(): void } }) {
      surfaces.order.push("resources");
      surfaces.resources = input;
    },
    enableProjectGit(input: Record<string, unknown>) {
      surfaces.order.push("git");
      surfaces.git = input;
    },
    async enableSharedProject(input: Record<string, unknown>) {
      surfaces.order.push("project");
      surfaces.project = input;
      return "enabled";
    },
    async shutdown() { /* the fail-closed path shuts a partial runtime down. */ },
  };
}

/** The owner-home dependencies the startup module threads into the composition. */
export function startupOptions(
  homePath: string,
  overrides: Partial<OwnerCollaborationStartupOptions> = {},
): OwnerCollaborationStartupOptions {
  return {
    homePath,
    chatRepository: { kysely: {} } as unknown as OwnerCollaborationStartupOptions["chatRepository"],
    appRegistry: { get: async () => null } as unknown as OwnerCollaborationStartupOptions["appRegistry"],
    canvasRepository: { kysely: {} } as unknown as OwnerCollaborationStartupOptions["canvasRepository"],
    collaborationConfig: { ownerId: HARNESS_OWNER_ID } as unknown as OwnerCollaborationStartupOptions["collaborationConfig"],
    providerSnapshotReader: {} as unknown as OwnerCollaborationStartupOptions["providerSnapshotReader"],
    codingAgentProjectManager: {
      listManagedProjects: async () => ({ projects: [] }),
      getProjectById: async () => ({ ok: false as const }),
      resolveProjectWorkingDirectory: async () => null,
    } as unknown as OwnerCollaborationStartupOptions["codingAgentProjectManager"],
    ownerChatExecutionRoots: {
      resolve: async () => ({ primaryWorkspaceRoot: homePath }),
    } as unknown as OwnerCollaborationStartupOptions["ownerChatExecutionRoots"],
    terminalWorkspaceRuntime: {
      listWorkspaces: async () => [],
      writeInput: async () => undefined,
      terminateTab: async () => undefined,
      attach: () => ({ close: () => {}, send: () => {} }),
    } as unknown as OwnerCollaborationStartupOptions["terminalWorkspaceRuntime"],
    ...overrides,
  };
}
