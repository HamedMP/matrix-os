import {
  type AgentCredentialSummary,
  type OnboardingGoalId,
  type OnboardingGoalSummary,
  type OnboardingStepSummary,
  type ReadinessGateId,
  type ReadinessGateSummary,
  type ReadinessResponse,
  type SelectGoalsResponse,
} from "./activation-contracts.js";
import {
  type OnboardingReadinessRecord,
  type ReadinessRepository,
} from "./readiness-repository.js";
import { ReadinessStatusCache } from "./readiness-cache.js";
import { ActivationRouteError } from "./activation-errors.js";

const GOALS: Record<OnboardingGoalId, Omit<OnboardingGoalSummary, "selected">> = {
  coding: {
    id: "coding",
    label: "Code with Matrix",
    description: "Connect a project, use Symphony, inspect terminal context, and receive a handoff.",
  },
  app_building: {
    id: "app_building",
    label: "Build apps",
    description: "Use Hermes to design and build Matrix apps with approved tools.",
  },
  company_brain: {
    id: "company_brain",
    label: "Run my company brain",
    description: "Capture decisions, customer notes, tasks, and growth context.",
  },
  assistant: {
    id: "assistant",
    label: "Use Matrix as an assistant",
    description: "Connect services for calendar, email, summaries, and operating tasks.",
  },
};

const GOAL_STEPS: Record<OnboardingGoalId, OnboardingStepSummary[]> = {
  coding: [
    { id: "github.connected", required: true, title: "Connect GitHub", unlocks: ["coding"] },
    { id: "project.selected", required: true, title: "Choose a project", unlocks: ["coding"] },
    { id: "symphony.ready", required: true, title: "Prepare Symphony", unlocks: ["coding"] },
    { id: "terminal.ready", required: false, title: "Verify terminal access", unlocks: ["coding"] },
  ],
  app_building: [
    { id: "hermes.available", required: true, title: "Verify Hermes", unlocks: ["app_building"] },
    { id: "skills.ready", required: true, title: "Verify app-building skills", unlocks: ["app_building"] },
  ],
  company_brain: [
    { id: "company_brain.ready", required: true, title: "Set up company context", unlocks: ["company_brain"] },
  ],
  assistant: [
    { id: "integrations.capabilities", required: true, title: "Approve assistant capabilities", unlocks: ["assistant", "integrations"] },
    { id: "hermes.available", required: true, title: "Verify Hermes", unlocks: ["assistant"] },
  ],
};

export function stepsForGoals(goalIds: OnboardingGoalId[]): OnboardingStepSummary[] {
  const stepsById = new Map<string, OnboardingStepSummary>();
  for (const goalId of Array.from(new Set(goalIds))) {
    for (const step of GOAL_STEPS[goalId]) {
      stepsById.set(step.id, step);
    }
  }
  return Array.from(stepsById.values());
}

const BASE_GATES: ReadinessGateSummary[] = [
  { id: "workspace.provisioned", category: "provisioning", criticality: "release_critical", status: "unknown", message: "Workspace provisioning has not been checked", remediation: "Retry workspace readiness", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "shell.routing", category: "shell", criticality: "release_critical", status: "unknown", message: "Shell routing has not been checked", remediation: "Verify the user workspace route", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "canvas.ready", category: "shell", criticality: "release_critical", status: "unknown", message: "Canvas readiness has not been checked", remediation: "Open Canvas and verify built-ins", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "terminal.ready", category: "coding", criticality: "goal_required", status: "unknown", message: "Terminal readiness has not been checked", remediation: "Open terminal for the selected project", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "skills.ready", category: "agent", criticality: "release_critical", status: "unknown", message: "Skill readiness has not been checked", remediation: "Verify Matrix skills are available", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "hermes.available", category: "agent", criticality: "release_critical", status: "pass", message: "Hermes is available as the Matrix system agent", remediation: null, owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "visual.qa", category: "ux", criticality: "release_critical", status: "unknown", message: "Onboarding visual QA has not been checked", remediation: "Run desktop and mobile visual QA", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "github.connected", category: "integration", criticality: "goal_required", status: "unknown", message: "GitHub is not connected yet", remediation: "Connect GitHub to unlock coding workflows", owner: "user", lastCheckedAt: null, evidence: [] },
  { id: "project.selected", category: "coding", criticality: "goal_required", status: "unknown", message: "No coding project is selected", remediation: "Choose a repository or project", owner: "user", lastCheckedAt: null, evidence: [] },
  { id: "symphony.ready", category: "coding", criticality: "goal_required", status: "unknown", message: "Symphony readiness has not been checked", remediation: "Verify Symphony configuration", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "integrations.capabilities", category: "integration", criticality: "goal_required", status: "unknown", message: "Assistant capabilities have not been approved", remediation: "Approve the needed integration capabilities", owner: "user", lastCheckedAt: null, evidence: [] },
  { id: "admin_control.ready", category: "admin_control", criticality: "release_critical", status: "unknown", message: "Admin control surface has not been checked", remediation: "Open model, settings, automation, activity, and readiness views", owner: "matrix", lastCheckedAt: null, evidence: [] },
  { id: "company_brain.ready", category: "company_brain", criticality: "recommended", status: "unknown", message: "Company brain setup has not been checked", remediation: "Add company context when ready", owner: "user", lastCheckedAt: null, evidence: [] },
  { id: "support_growth.ready", category: "support_growth", criticality: "optional", status: "unknown", message: "Support and growth workflows are not configured", remediation: "Connect publishing or support workflows later", owner: "user", lastCheckedAt: null, evidence: [] },
  { id: "entitlement.ready", category: "entitlement", criticality: "release_critical", status: "unknown", message: "Entitlement gate has not been checked", remediation: "Verify paid access policy", owner: "operator", lastCheckedAt: null, evidence: [] },
];

const DEFAULT_AGENTS: AgentCredentialSummary[] = [
  {
    agent: "claude",
    status: "missing",
    coordinationRole: "core_agent",
    workflows: ["core_agent"],
    degradedWorkflows: ["core_agent"],
    verifiedAt: null,
    nextAction: "Connect Claude to enable the core agent path",
  },
  {
    agent: "codex",
    status: "missing",
    coordinationRole: "coding_specialist",
    workflows: ["coding"],
    degradedWorkflows: ["coding"],
    verifiedAt: null,
    nextAction: "Connect Codex for optional coding support",
  },
  {
    agent: "hermes",
    status: "available",
    coordinationRole: "system_agent",
    workflows: ["app_building", "assistant", "integrations", "company_brain"],
    degradedWorkflows: [],
    verifiedAt: null,
    nextAction: null,
  },
];

export interface ReadinessService {
  getReadiness(ownerId: string): Promise<ReadinessResponse>;
  selectGoals(ownerId: string, goalIds: OnboardingGoalId[]): Promise<SelectGoalsResponse>;
  retryGate(ownerId: string, gateId: ReadinessGateId): Promise<{ gateId: ReadinessGateId; status: "checking" }>;
}

export function createReadinessService(options: {
  repository: ReadinessRepository;
  cache?: ReadinessStatusCache<ReadinessResponse>;
  now?: () => Date;
}): ReadinessService {
  const now = options.now ?? (() => new Date());
  const cache = options.cache ?? new ReadinessStatusCache<ReadinessResponse>({ maxEntries: 512, ttlMs: 10_000 });

  async function ensureRecord(ownerId: string): Promise<OnboardingReadinessRecord> {
    const existing = await options.repository.get(ownerId);
    if (existing) return existing;
    return options.repository.save({
      ownerId,
      selectedGoalIds: [],
      completedStepIds: [],
      skippedStepIds: [],
      gateOverrides: {},
      updatedAt: now().toISOString(),
    });
  }

  function deriveGates(record: OnboardingReadinessRecord): ReadinessGateSummary[] {
    return BASE_GATES.map((gate) => {
      const override = record.gateOverrides[gate.id];
      if (!override) return { ...gate };
      return {
        ...gate,
        status: override.status,
        message: override.message ?? gate.message,
        remediation: Object.prototype.hasOwnProperty.call(override, "remediation")
          ? override.remediation ?? null
          : gate.remediation,
        lastCheckedAt: override.lastCheckedAt ?? gate.lastCheckedAt,
        evidence: override.evidence ?? gate.evidence,
      };
    });
  }

  function deriveOverallStatus(gates: ReadinessGateSummary[]) {
    const releaseCritical = gates.filter((gate) => gate.criticality === "release_critical");
    if (releaseCritical.some((gate) => gate.status === "blocked" || gate.status === "fail")) return "blocked" as const;
    if (releaseCritical.some((gate) => gate.status === "checking")) return "checking" as const;
    if (releaseCritical.every((gate) => gate.status === "pass" || gate.status === "skipped")) return "ready" as const;
    return "degraded" as const;
  }

  async function getReadiness(ownerId: string): Promise<ReadinessResponse> {
    const cached = cache.get(ownerId);
    if (cached) return cached;
    const record = await ensureRecord(ownerId);
    const gates = deriveGates(record);
    const goals = Object.values(GOALS).map((goal) => ({
      ...goal,
      selected: record.selectedGoalIds.includes(goal.id),
    }));
    const response: ReadinessResponse = {
      overallStatus: deriveOverallStatus(gates),
      goals,
      gates,
      systemAgent: "hermes",
      activeAgents: ["hermes"],
      agents: DEFAULT_AGENTS.map((agent) => ({ ...agent })),
    };
    cache.set(ownerId, response);
    return response;
  }

  async function selectGoals(ownerId: string, goalIds: OnboardingGoalId[]): Promise<SelectGoalsResponse> {
    const uniqueGoalIds = Array.from(new Set(goalIds));
    const record = await ensureRecord(ownerId);
    await options.repository.save({
      ...record,
      selectedGoalIds: uniqueGoalIds,
      updatedAt: now().toISOString(),
    });
    cache.delete(ownerId);
    return { goalIds: uniqueGoalIds, steps: stepsForGoals(uniqueGoalIds) };
  }

  async function retryGate(ownerId: string, gateId: ReadinessGateId) {
    if (!BASE_GATES.some((gate) => gate.id === gateId)) {
      throw new ActivationRouteError("gate_not_found", "Readiness gate was not found", { status: 404 });
    }
    const record = await ensureRecord(ownerId);
    await options.repository.save({
      ...record,
      gateOverrides: {
        ...record.gateOverrides,
        [gateId]: {
          status: "checking",
          message: "Readiness check is running",
          remediation: null,
          lastCheckedAt: now().toISOString(),
        },
      },
      updatedAt: now().toISOString(),
    });
    cache.delete(ownerId);
    return { gateId, status: "checking" as const };
  }

  return { getReadiness, selectGoals, retryGate };
}

