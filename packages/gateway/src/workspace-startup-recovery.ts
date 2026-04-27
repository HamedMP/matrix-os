import { resolve } from "node:path";
import { createAgentLauncher } from "./agent-launcher.js";
import { createAgentSandbox } from "./agent-sandbox.js";
import { createAgentSessionManager, type WorkspaceSessionView } from "./agent-session-manager.js";
import { createPreviewManager } from "./preview-manager.js";
import { createProjectManager, type ProjectConfig } from "./project-manager.js";
import { createReviewStore } from "./review-store.js";
import { createSessionTranscriptManager } from "./session-transcript.js";
import { createStateOps } from "./state-ops.js";
import { createWorktreeManager } from "./worktree-manager.js";
import { createZellijRuntime } from "./zellij-runtime.js";

type StepName =
  | "stateOps"
  | "projects"
  | "worktreeLeases"
  | "runtimeSessions"
  | "bridges"
  | "transcripts"
  | "reviews"
  | "sandbox"
  | "browserIde"
  | "previews";

export type WorkspaceStartupStep = {
  name: StepName;
  status: "ok" | "degraded";
  errorCode?: "startup_recovery_failed" | "manager_error";
  cleanedStaging?: number;
  projects?: number;
  worktrees?: number;
  checked?: number;
  degraded?: number;
  rehydrated?: number;
  retentionDeleted?: number;
  retentionTruncated?: number;
  reviews?: number;
  previews?: number;
  configured?: boolean;
  available?: boolean;
};

export interface WorkspaceStartupRecoveryResult {
  status: "ok" | "degraded";
  steps: WorkspaceStartupStep[];
}

type ProjectListResult = { projects: Array<Pick<ProjectConfig, "slug">>; nextCursor: string | null };
type ReviewListResult = { ok: true; reviews: unknown[]; nextCursor: string | null };
type PreviewListResult = { ok: true; previews: unknown[]; nextCursor: string | null };
type MaybeFailure = { ok: false; error: { code: string; message: string } };

export interface WorkspaceStartupRecoveryDeps {
  stateOps: {
    recoverOperations: () => Promise<{ cleanedStaging: string[] }>;
  };
  projectManager: {
    listManagedProjects: () => Promise<ProjectListResult>;
  };
  worktreeManager: {
    listWorktrees: (projectSlug: string) => Promise<{ ok: true; worktrees: unknown[] } | MaybeFailure>;
  };
  agentSessionManager: {
    reconcileStartup: () => Promise<{ checked: number; degraded: number; releasedLeases: number }>;
    listSessions: (input?: unknown) => Promise<{ ok: true; sessions: WorkspaceSessionView[]; nextCursor: string | null } | MaybeFailure>;
  };
  bridgeRecovery?: {
    recoverStartup: (sessions: WorkspaceSessionView[]) => Promise<{ checked: number }>;
  };
  transcriptManager: {
    rehydrate: (sessionId: string) => Promise<{ ok: true } | MaybeFailure>;
    applyRetention: () => Promise<{ deleted: string[]; truncated: string[] }>;
  };
  reviewStore: {
    listReviews: (input?: unknown) => Promise<ReviewListResult | MaybeFailure>;
  };
  agentSandbox: {
    status: () => Promise<{ available: boolean; enforced: boolean; requiresAdminOverride: boolean; reason: string }>;
  };
  browserIde: {
    status: () => Promise<{ enabled: boolean; configured: boolean }>;
  };
  previewManager: {
    listPreviews: (projectSlug: string, input?: unknown) => Promise<PreviewListResult | MaybeFailure>;
  };
  logger?: Pick<Console, "warn">;
}

function warnRecoveryFailure(logger: Pick<Console, "warn"> | undefined, step: StepName, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  logger?.warn(`[workspace-startup-recovery] ${step} failed: ${detail}`);
}

async function step(
  steps: WorkspaceStartupStep[],
  name: StepName,
  logger: Pick<Console, "warn"> | undefined,
  callback: () => Promise<Omit<WorkspaceStartupStep, "name" | "status">>,
): Promise<boolean> {
  try {
    steps.push({ name, status: "ok", ...await callback() });
    return true;
  } catch (err: unknown) {
    warnRecoveryFailure(logger, name, err);
    steps.push({ name, status: "degraded", errorCode: "startup_recovery_failed" });
    return false;
  }
}

export async function runWorkspaceStartupRecovery(
  deps: WorkspaceStartupRecoveryDeps,
): Promise<WorkspaceStartupRecoveryResult> {
  const steps: WorkspaceStartupStep[] = [];
  const logger = deps.logger ?? console;
  let projects: Array<Pick<ProjectConfig, "slug">> = [];
  let sessions: WorkspaceSessionView[] = [];

  await step(steps, "stateOps", logger, async () => {
    const recovered = await deps.stateOps.recoverOperations();
    return { cleanedStaging: recovered.cleanedStaging.length };
  });

  await step(steps, "projects", logger, async () => {
    const result = await deps.projectManager.listManagedProjects();
    projects = result.projects;
    return { projects: projects.length };
  });

  await step(steps, "worktreeLeases", logger, async () => {
    let worktrees = 0;
    for (const project of projects) {
      const result = await deps.worktreeManager.listWorktrees(project.slug);
      if (!result.ok) return { errorCode: "manager_error" as const, worktrees };
      worktrees += result.worktrees.length;
    }
    return { worktrees };
  });

  await step(steps, "runtimeSessions", logger, async () => {
    const reconciled = await deps.agentSessionManager.reconcileStartup();
    const listed = await deps.agentSessionManager.listSessions({});
    if (!listed.ok) {
      return {
        errorCode: "manager_error" as const,
        checked: reconciled.checked,
        degraded: reconciled.degraded,
      };
    }
    sessions = listed.sessions;
    return { checked: reconciled.checked, degraded: reconciled.degraded };
  });

  await step(steps, "bridges", logger, async () => {
    const recovered = deps.bridgeRecovery
      ? await deps.bridgeRecovery.recoverStartup(sessions)
      : { checked: sessions.length };
    return { checked: recovered.checked };
  });

  await step(steps, "transcripts", logger, async () => {
    let rehydrated = 0;
    for (const session of sessions) {
      const result = await deps.transcriptManager.rehydrate(session.id);
      if (result.ok) rehydrated += 1;
    }
    const retained = await deps.transcriptManager.applyRetention();
    return {
      rehydrated,
      retentionDeleted: retained.deleted.length,
      retentionTruncated: retained.truncated.length,
    };
  });

  await step(steps, "reviews", logger, async () => {
    const listed = await deps.reviewStore.listReviews({ limit: 100 });
    if (!listed.ok) return { errorCode: "manager_error" as const, reviews: 0 };
    return { reviews: listed.reviews.length };
  });

  await step(steps, "sandbox", logger, async () => {
    const status = await deps.agentSandbox.status();
    return { available: status.available };
  });

  await step(steps, "browserIde", logger, async () => {
    const status = await deps.browserIde.status();
    return { configured: status.configured, available: status.enabled };
  });

  await step(steps, "previews", logger, async () => {
    let previews = 0;
    for (const project of projects) {
      const listed = await deps.previewManager.listPreviews(project.slug, { limit: 100 });
      if (!listed.ok) return { errorCode: "manager_error" as const, previews };
      previews += listed.previews.length;
    }
    return { previews };
  });

  return {
    status: steps.some((entry) => entry.status === "degraded" || entry.errorCode) ? "degraded" : "ok",
    steps,
  };
}

export function createWorkspaceStartupRecovery(options: { homePath: string }) {
  const homePath = resolve(options.homePath);
  const stateOps = createStateOps({ homePath });
  const projectManager = createProjectManager({ homePath });
  const worktreeManager = createWorktreeManager({ homePath });
  const agentLauncher = createAgentLauncher({ cwd: homePath });
  const zellijRuntime = createZellijRuntime({ homePath });
  const agentSessionManager = createAgentSessionManager({
    homePath,
    worktreeManager,
    agentLauncher,
    zellijRuntime,
  });

  return {
    run: () => runWorkspaceStartupRecovery({
      stateOps,
      projectManager,
      worktreeManager,
      agentSessionManager,
      transcriptManager: createSessionTranscriptManager({ homePath }),
      reviewStore: createReviewStore({ homePath }),
      agentSandbox: createAgentSandbox({ homePath }),
      browserIde: {
        status: async () => ({
          enabled: Boolean(process.env.MATRIX_CODE_SERVER_PORT),
          configured: Boolean(process.env.MATRIX_CODE_SERVER_PORT),
        }),
      },
      previewManager: createPreviewManager({ homePath }),
    }),
  };
}
