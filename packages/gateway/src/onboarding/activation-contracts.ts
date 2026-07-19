import { z } from "zod/v4";

const SAFE_ID = /^[a-z][a-z0-9_.-]{1,120}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const OnboardingGoalIdSchema = z.enum([
  "coding",
  "app_building",
  "company_brain",
  "assistant",
]);
export type OnboardingGoalId = z.infer<typeof OnboardingGoalIdSchema>;

export const ReadinessGateCategorySchema = z.enum([
  "provisioning",
  "shell",
  "ux",
  "agent",
  "coding",
  "integration",
  "admin_control",
  "company_brain",
  "support_growth",
  "entitlement",
]);
export type ReadinessGateCategory = z.infer<typeof ReadinessGateCategorySchema>;

export const ReadinessCriticalitySchema = z.enum([
  "release_critical",
  "goal_required",
  "recommended",
  "optional",
]);
export type ReadinessCriticality = z.infer<typeof ReadinessCriticalitySchema>;

export const ReadinessGateStatusSchema = z.enum([
  "unknown",
  "checking",
  "pass",
  "fail",
  "blocked",
  "skipped",
]);
export type ReadinessGateStatus = z.infer<typeof ReadinessGateStatusSchema>;

export const ReadinessOwnerSchema = z.enum(["user", "operator", "matrix"]);
export type ReadinessOwner = z.infer<typeof ReadinessOwnerSchema>;

export const AgentIdSchema = z.enum(["claude", "codex", "hermes"]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AgentCredentialStatusSchema = z.enum([
  "available",
  "missing",
  "auth_required",
  "check_failed",
  "version_unsupported",
  "expired",
  "revoked",
  "failed",
  "not_applicable",
]);
export type AgentCredentialStatus = z.infer<typeof AgentCredentialStatusSchema>;

export const AgentCoordinationRoleSchema = z.enum([
  "system_agent",
  "core_agent",
  "coding_specialist",
  "assistant_specialist",
]);
export type AgentCoordinationRole = z.infer<typeof AgentCoordinationRoleSchema>;

export const WorkflowIdSchema = z.enum([
  "core_agent",
  "coding",
  "app_building",
  "assistant",
  "integrations",
  "company_brain",
  "support_growth",
]);
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

export const ReadinessGateIdSchema = z.string()
  .min(2)
  .max(120)
  .regex(SAFE_ID);
export type ReadinessGateId = z.infer<typeof ReadinessGateIdSchema>;

export const SafeDisplayTextSchema = z.string().trim().min(1).max(240);
export const OptionalSafeDisplayTextSchema = z.string().trim().min(1).max(240).nullable();
export const ActivationDateSchema = z.string().regex(ISO_DATETIME);

export const ReadinessGateSummarySchema = z.object({
  id: ReadinessGateIdSchema,
  category: ReadinessGateCategorySchema,
  criticality: ReadinessCriticalitySchema,
  status: ReadinessGateStatusSchema,
  message: SafeDisplayTextSchema,
  remediation: OptionalSafeDisplayTextSchema,
  owner: ReadinessOwnerSchema,
  lastCheckedAt: ActivationDateSchema.nullable(),
  evidence: z.array(z.string().trim().min(1).max(240)).max(12).default([]),
});
export type ReadinessGateSummary = z.infer<typeof ReadinessGateSummarySchema>;

export const OnboardingGoalSummarySchema = z.object({
  id: OnboardingGoalIdSchema,
  selected: z.boolean(),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
});
export type OnboardingGoalSummary = z.infer<typeof OnboardingGoalSummarySchema>;

export const OnboardingStepSummarySchema = z.object({
  id: ReadinessGateIdSchema,
  required: z.boolean(),
  title: z.string().trim().min(1).max(100),
  unlocks: z.array(WorkflowIdSchema).min(1).max(8),
});
export type OnboardingStepSummary = z.infer<typeof OnboardingStepSummarySchema>;

export const AgentCredentialSummarySchema = z.object({
  agent: AgentIdSchema,
  status: AgentCredentialStatusSchema,
  coordinationRole: AgentCoordinationRoleSchema,
  workflows: z.array(WorkflowIdSchema).max(8),
  degradedWorkflows: z.array(WorkflowIdSchema).max(8).default([]),
  verifiedAt: ActivationDateSchema.nullable(),
  nextAction: OptionalSafeDisplayTextSchema,
});
export type AgentCredentialSummary = z.infer<typeof AgentCredentialSummarySchema>;

export const AgentCredentialStatusResponseSchema = z.object({
  systemAgent: z.literal("hermes"),
  activeAgents: z.array(AgentIdSchema).min(1).max(3),
  agents: z.array(AgentCredentialSummarySchema),
  routingExplanation: z.string().trim().min(1).max(300),
});
export type AgentCredentialStatusResponse = z.infer<typeof AgentCredentialStatusResponseSchema>;

export const AgentCredentialParamsSchema = z.object({
  agent: AgentIdSchema,
});
export type AgentCredentialParams = z.infer<typeof AgentCredentialParamsSchema>;

export const VerifyAgentCredentialResponseSchema = z.object({
  agent: AgentIdSchema,
  status: AgentCredentialStatusSchema,
  verifiedAt: ActivationDateSchema,
});
export type VerifyAgentCredentialResponse = z.infer<typeof VerifyAgentCredentialResponseSchema>;

export const IntegrationCapabilityStatusSchema = z.enum([
  "connect_required",
  "connected",
  "approved",
  "revoked",
  "failed",
  "unavailable",
]);
export type IntegrationCapabilityStatus = z.infer<typeof IntegrationCapabilityStatusSchema>;

export const IntegrationProviderSchema = z.enum([
  "github",
  "calendar",
  "email",
  "messaging",
  "publishing",
]);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

export const IntegrationCapabilitySummarySchema = z.object({
  id: ReadinessGateIdSchema,
  provider: IntegrationProviderSchema,
  capability: z.string().trim().min(1).max(80),
  status: IntegrationCapabilityStatusSchema,
  approvedAgents: z.array(AgentIdSchema).max(3),
  requiresApprovalPerAction: z.boolean(),
});
export type IntegrationCapabilitySummary = z.infer<typeof IntegrationCapabilitySummarySchema>;

export const IntegrationCapabilitiesResponseSchema = z.object({
  capabilities: z.array(IntegrationCapabilitySummarySchema),
});
export type IntegrationCapabilitiesResponse = z.infer<typeof IntegrationCapabilitiesResponseSchema>;

export const ApproveCapabilityRequestSchema = z.object({
  agent: AgentIdSchema,
  approved: z.boolean(),
});
export type ApproveCapabilityRequest = z.infer<typeof ApproveCapabilityRequestSchema>;

export const CapabilityParamsSchema = z.object({
  capabilityId: ReadinessGateIdSchema,
});
export type CapabilityParams = z.infer<typeof CapabilityParamsSchema>;

export const ApproveCapabilityResponseSchema = z.object({
  capabilityId: ReadinessGateIdSchema,
  agent: AgentIdSchema,
  status: IntegrationCapabilityStatusSchema,
});
export type ApproveCapabilityResponse = z.infer<typeof ApproveCapabilityResponseSchema>;

export const AgentActionStatusSchema = z.enum([
  "requested",
  "approved",
  "completed",
  "failed",
  "denied",
]);
export type AgentActionStatus = z.infer<typeof AgentActionStatusSchema>;

export const AgentActionSummarySchema = z.object({
  id: ReadinessGateIdSchema,
  agent: AgentIdSchema,
  capability: ReadinessGateIdSchema,
  status: AgentActionStatusSchema,
  summary: SafeDisplayTextSchema,
  target: SafeDisplayTextSchema,
  createdAt: ActivationDateSchema,
  completedAt: ActivationDateSchema.nullable(),
});
export type AgentActionSummary = z.infer<typeof AgentActionSummarySchema>;

export const RecordAgentActionRequestSchema = z.object({
  agent: AgentIdSchema,
  capability: ReadinessGateIdSchema,
  status: AgentActionStatusSchema,
  summary: SafeDisplayTextSchema,
  target: SafeDisplayTextSchema,
});
export type RecordAgentActionRequest = z.infer<typeof RecordAgentActionRequestSchema>;

export const AgentActionsResponseSchema = z.object({
  actions: z.array(AgentActionSummarySchema).max(500),
});
export type AgentActionsResponse = z.infer<typeof AgentActionsResponseSchema>;

export const ReadinessOverallStatusSchema = z.enum([
  "ready",
  "degraded",
  "blocked",
  "checking",
]);
export type ReadinessOverallStatus = z.infer<typeof ReadinessOverallStatusSchema>;

export const CodingHandoffStatusSchema = z.enum([
  "idle",
  "running",
  "needs_input",
  "ready",
  "failed",
]);
export type CodingHandoffStatus = z.infer<typeof CodingHandoffStatusSchema>;

export const ReadinessResponseSchema = z.object({
  overallStatus: ReadinessOverallStatusSchema,
  goals: z.array(OnboardingGoalSummarySchema),
  gates: z.array(ReadinessGateSummarySchema),
  systemAgent: z.literal("hermes"),
  activeAgents: z.array(AgentIdSchema).min(1).max(3),
  agents: z.array(AgentCredentialSummarySchema),
  codingHandoffStatus: CodingHandoffStatusSchema.nullable(),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const SelectGoalsRequestSchema = z.object({
  goalIds: z.array(OnboardingGoalIdSchema).min(1).max(4),
});
export type SelectGoalsRequest = z.infer<typeof SelectGoalsRequestSchema>;

export const SelectGoalsResponseSchema = z.object({
  goalIds: z.array(OnboardingGoalIdSchema).min(1).max(4),
  steps: z.array(OnboardingStepSummarySchema),
});
export type SelectGoalsResponse = z.infer<typeof SelectGoalsResponseSchema>;

export const RetryGateParamsSchema = z.object({
  gateId: ReadinessGateIdSchema,
});
export type RetryGateParams = z.infer<typeof RetryGateParamsSchema>;

export const RetryGateResponseSchema = z.object({
  gateId: ReadinessGateIdSchema,
  status: z.literal("checking"),
});
export type RetryGateResponse = z.infer<typeof RetryGateResponseSchema>;

export const ToolPackIdSchema = z.enum([
  "coding-agents",
  "code-server",
  "hermes",
  "linux-tools",
]);
export type ToolPackId = z.infer<typeof ToolPackIdSchema>;

export const ToolPackCategorySchema = z.enum([
  "agent",
  "editor",
  "system",
]);
export type ToolPackCategory = z.infer<typeof ToolPackCategorySchema>;

export const ToolPackInstallStatusSchema = z.enum([
  "available",
  "selected",
  "installing",
  "installed",
  "failed",
  "unavailable",
]);
export type ToolPackInstallStatus = z.infer<typeof ToolPackInstallStatusSchema>;

export const ToolPackSummarySchema = z.object({
  id: ToolPackIdSchema,
  category: ToolPackCategorySchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  commands: z.array(z.string().trim().min(1).max(40).regex(SAFE_ID)).max(8),
  selected: z.boolean(),
  installed: z.boolean(),
  defaultSelected: z.boolean(),
  status: ToolPackInstallStatusSchema,
  installJobId: ReadinessGateIdSchema.nullable(),
});
export type ToolPackSummary = z.infer<typeof ToolPackSummarySchema>;

export const ToolPackInstallJobStatusSchema = z.enum([
  "installing",
  "installed",
  "failed",
]);
export type ToolPackInstallJobStatus = z.infer<typeof ToolPackInstallJobStatusSchema>;

export const ToolPackInstallJobSummarySchema = z.object({
  id: ReadinessGateIdSchema,
  packId: ToolPackIdSchema,
  status: ToolPackInstallJobStatusSchema,
  startedAt: ActivationDateSchema,
  completedAt: ActivationDateSchema.nullable(),
  message: OptionalSafeDisplayTextSchema,
});
export type ToolPackInstallJobSummary = z.infer<typeof ToolPackInstallJobSummarySchema>;

export const ToolPacksResponseSchema = z.object({
  packs: z.array(ToolPackSummarySchema).min(1).max(8),
  selectedPackIds: z.array(ToolPackIdSchema).max(8),
  installJobs: z.array(ToolPackInstallJobSummarySchema).max(64),
});
export type ToolPacksResponse = z.infer<typeof ToolPacksResponseSchema>;

export const SelectToolPacksRequestSchema = z.object({
  packIds: z.array(ToolPackIdSchema).min(1).max(8),
});
export type SelectToolPacksRequest = z.infer<typeof SelectToolPacksRequestSchema>;

export const ActivationErrorResponseSchema = z.object({
  error: z.string().min(1).max(80),
  message: z.string().min(1).max(160),
  retryable: z.boolean(),
});
export type ActivationErrorResponse = z.infer<typeof ActivationErrorResponseSchema>;
