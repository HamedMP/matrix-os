import type { AgentCredentialStatusService } from "./agent-credential-status.js";
import type { IntegrationCapabilityService } from "./integration-capabilities.js";
import type { ReadinessService } from "./readiness-service.js";

const MAX_SETUP_SESSIONS = 512;
const MAX_SETUP_SESSIONS_PER_OWNER = 16;
const SETUP_SESSION_TTL_MS = 1000 * 60 * 60 * 24;

export interface AdminProviderCard {
  id: "hermes" | "claude" | "codex" | string;
  label: string;
  status: "available" | "missing" | "auth_required" | "check_failed" | "version_unsupported" | "expired" | "revoked" | "failed" | "not_applicable" | "connected" | "approved" | "unavailable";
  mode: "matrix_system_agent" | "bring_your_own" | "integration";
  nextAction: string | null;
}

export interface AdminSettingSummary {
  id: string;
  label: string;
  status: "saved" | "needs_review" | "failed";
  updatedAt: string;
}

export interface AdminSetupSession {
  id: string;
  target: string;
  status: "new" | "resumable";
  title: string;
  updatedAt: string;
}

export interface AdminControlSurface {
  sections: string[];
  providers: AdminProviderCard[];
  settings: AdminSettingSummary[];
  automationSummary: {
    active: number;
    needsApproval: number;
    lastActivityAt: string | null;
  };
  integrationSummary: {
    connected: number;
    approved: number;
    needsConnection: number;
  };
  readiness: {
    overallStatus: string;
    blocked: number;
    failed: number;
    ready: number;
  };
  activity: Array<{
    id: string;
    kind: "readiness" | "integration" | "automation" | "setting";
    summary: string;
    createdAt: string;
  }>;
  setupSession: AdminSetupSession | null;
}

export interface AdminControlService {
  getSurface(ownerId: string): Promise<AdminControlSurface>;
  createOrResumeSetupSession(ownerId: string, input: { target: string; intent: "connect" | "configure" | "resume" }): Promise<{ session: AdminSetupSession }>;
}

function labelForTarget(target: string): string {
  if (target === "agent:claude") return "Connect Claude";
  if (target === "agent:codex") return "Connect Codex";
  if (target.startsWith("integration:")) return "Connect integration";
  if (target.startsWith("setting:")) return "Configure setting";
  return "Resume setup";
}

function labelForIntegrationProvider(provider: string): string {
  if (provider === "github") return "GitHub";
  if (provider === "calendar") return "Calendar";
  if (provider === "email") return "Email";
  return provider.charAt(0).toUpperCase() + provider.slice(1).replace(/_/g, " ");
}

export function createAdminControlService(options: {
  agentCredentials: AgentCredentialStatusService;
  integrations: IntegrationCapabilityService;
  readiness: ReadinessService;
  now?: () => Date;
}): AdminControlService {
  const now = options.now ?? (() => new Date());
  const setupSessions = new Map<string, AdminSetupSession>();

  function sessionKey(ownerId: string, target: string): string {
    return `${encodeURIComponent(ownerId)}:${target}`;
  }

  function sessionBelongsToOwner(key: string, ownerId: string): boolean {
    return key.startsWith(`${encodeURIComponent(ownerId)}:`);
  }

  function sweepSetupSessions(timestampMs = now().getTime()): void {
    for (const [key, session] of setupSessions) {
      const updatedAt = Date.parse(session.updatedAt);
      if (!Number.isFinite(updatedAt) || timestampMs - updatedAt > SETUP_SESSION_TTL_MS) {
        setupSessions.delete(key);
      }
    }
  }

  async function getSurface(ownerId: string): Promise<AdminControlSurface> {
    const currentTime = now();
    const timestamp = currentTime.toISOString();
    sweepSetupSessions(currentTime.getTime());
    const [agentStatus, integrationStatus, readiness] = await Promise.all([
      options.agentCredentials.getStatus(ownerId),
      options.integrations.listCapabilities(ownerId),
      options.readiness.getReadiness(ownerId),
    ]);
    const providers: AdminProviderCard[] = [
      ...agentStatus.agents.map((agent) => ({
        id: agent.agent,
        label: agent.agent === "hermes" ? "Hermes" : agent.agent === "claude" ? "Claude" : "Codex",
        status: agent.status,
        mode: agent.agent === "hermes" ? "matrix_system_agent" as const : "bring_your_own" as const,
        nextAction: agent.nextAction,
      })),
      ...integrationStatus.capabilities.slice(0, 4).map((capability) => ({
        id: capability.id,
        label: labelForIntegrationProvider(capability.provider),
        status: capability.status === "connect_required" ? "missing" as const : capability.status,
        mode: "integration" as const,
        nextAction: capability.status === "approved" || capability.status === "unavailable"
          ? null
          : capability.status === "connect_required"
            ? `Connect ${labelForIntegrationProvider(capability.provider)}`
            : `Approve ${labelForIntegrationProvider(capability.provider)}`,
      })),
    ];
    const approved = integrationStatus.capabilities.filter((capability) => capability.status === "approved").length;
    const connected = integrationStatus.capabilities.filter((capability) => capability.status === "connected" || capability.status === "approved").length;
    const needsConnection = integrationStatus.capabilities.filter((capability) => capability.status === "connect_required").length;
    let integrationApprovalStatus: "saved" | "needs_review" = "needs_review";
    if (needsConnection > 0) {
      integrationApprovalStatus = "needs_review";
    } else if (connected === 0) {
      integrationApprovalStatus = "saved";
    } else if (connected > approved) {
      integrationApprovalStatus = "needs_review";
    } else if (approved > 0) {
      integrationApprovalStatus = "saved";
    }
    const failed = readiness.gates.filter((gate) => gate.status === "fail").length;
    const blocked = readiness.gates.filter((gate) => gate.status === "blocked").length;
    const ready = readiness.gates.filter((gate) => gate.status === "pass").length;
    const activity = [
      {
        id: "activity.readiness",
        kind: "readiness" as const,
        summary: readiness.overallStatus === "ready" ? "Readiness is green" : "Readiness needs review",
        createdAt: timestamp,
      },
      {
        id: "activity.integrations",
        kind: "integration" as const,
        summary: approved > 0 ? "Hermes has approved capabilities" : "Integration approval is pending",
        createdAt: timestamp,
      },
    ];
    const latestSession = Array.from(setupSessions.entries())
      .filter(([key]) => sessionBelongsToOwner(key, ownerId))
      .map(([, session]) => session)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;

    return {
      sections: ["models", "agents", "integrations", "settings", "automations", "activity", "readiness"],
      providers,
      settings: [
        { id: "agent-routing", label: "Agent routing", status: "saved", updatedAt: timestamp },
        { id: "integration-approvals", label: "Integration approvals", status: integrationApprovalStatus, updatedAt: timestamp },
        { id: "readiness-gates", label: "Readiness gates", status: failed || blocked ? "needs_review" : "saved", updatedAt: timestamp },
      ],
      automationSummary: {
        active: 0,
        needsApproval: 0,
        lastActivityAt: null,
      },
      integrationSummary: { connected, approved, needsConnection },
      readiness: { overallStatus: readiness.overallStatus, blocked, failed, ready },
      activity,
      setupSession: latestSession,
    };
  }

  async function createOrResumeSetupSession(ownerId: string, input: { target: string; intent: "connect" | "configure" | "resume" }) {
    const currentTime = now();
    sweepSetupSessions(currentTime.getTime());
    const key = sessionKey(ownerId, input.target);
    const existing = setupSessions.get(key);
    if (existing && input.intent === "resume") {
      const resumed = { ...existing, status: "resumable" as const, updatedAt: currentTime.toISOString() };
      setupSessions.delete(key);
      setupSessions.set(key, resumed);
      return { session: resumed };
    }
    if (existing) setupSessions.delete(key);
    const ownerSessions = Array.from(setupSessions.entries())
      .filter(([entryKey]) => sessionBelongsToOwner(entryKey, ownerId))
      .sort((left, right) => Date.parse(left[1].updatedAt) - Date.parse(right[1].updatedAt));
    if (ownerSessions.length >= MAX_SETUP_SESSIONS_PER_OWNER) {
      setupSessions.delete(ownerSessions[0][0]);
    } else if (setupSessions.size >= MAX_SETUP_SESSIONS) {
      const oldestKey = setupSessions.keys().next().value as string | undefined;
      if (oldestKey) setupSessions.delete(oldestKey);
    }
    const session: AdminSetupSession = {
      id: `setup.${ownerId}.${input.target.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`,
      target: input.target,
      status: "new",
      title: labelForTarget(input.target),
      updatedAt: currentTime.toISOString(),
    };
    setupSessions.set(key, session);
    return { session };
  }

  return { getSurface, createOrResumeSetupSession };
}
