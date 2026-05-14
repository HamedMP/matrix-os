import { z } from "zod/v4";

export const SYMPHONY_APP_ID = "symphony";
export const SYMPHONY_BODY_LIMIT = 16 * 1024;
export const SYMPHONY_EMPTY_BODY_LIMIT = 4 * 1024;
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_CONCURRENT_AGENTS = 3;
export const MAX_CONCURRENT_AGENTS = 10;
export const MAX_PREVIEW_TICKETS = 100;
export const MAX_RUNS = 100;
export const MAX_EVENTS = 500;

export const SymphonyRunStatusSchema = z.enum([
  "queued",
  "running",
  "retrying",
  "blocked",
  "stopped",
  "failed",
  "handoff",
  "completed",
]);

export const SymphonyAgentSchema = z.enum(["codex", "claude", "opencode", "pi"]);

const BoundedString = z.string().trim().min(1).max(200);
const OptionalBoundedString = z.string().trim().max(200).optional();
const LinearId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const LabelOrState = z.string().trim().min(1).max(64);
const MatrixUserId = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const ProjectSlugSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const SymphonyInstallationInputSchema = z.object({
  projectSlug: ProjectSlugSchema,
  pollIntervalMs: z.number().int().min(5_000).max(10 * 60_000).default(DEFAULT_POLL_INTERVAL_MS),
  maxConcurrentAgents: z.number().int().min(1).max(MAX_CONCURRENT_AGENTS).default(DEFAULT_MAX_CONCURRENT_AGENTS),
  defaultAgent: SymphonyAgentSchema.default("codex"),
  authorizedOperators: z.array(MatrixUserId).max(50).default([]),
}).strict();

export const SymphonyRuleInputSchema = z.object({
  teamId: LinearId,
  teamKey: z.string().trim().min(1).max(32),
  projectId: LinearId.optional(),
  projectSlug: z.string().trim().min(1).max(128).optional(),
  requiredLabels: z.array(LabelOrState).max(20).default([]),
  activeStates: z.array(LabelOrState).min(1).max(20).default(["Todo", "In Progress"]),
  terminalStates: z.array(LabelOrState).min(1).max(20).default(["Done", "Canceled", "Cancelled", "Duplicate"]),
  assigneeIds: z.array(LinearId).max(50).default([]),
}).strict();

export const SaveSymphonyConfigSchema = z.object({
  installation: SymphonyInstallationInputSchema,
  rule: SymphonyRuleInputSchema,
}).strict();

export const LinearCredentialSchema = z.object({
  kind: z.literal("api_key"),
  secret: z.string().trim().min(8).max(4096),
}).strict();

export const PreviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PREVIEW_TICKETS).default(25),
  state: z.string().trim().min(1).max(64).optional(),
}).strict();

export const RunsQuerySchema = z.object({
  status: SymphonyRunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RUNS).default(100),
  cursor: z.string().trim().min(1).max(256).optional(),
}).strict();

export const EmptyBodySchema = z.object({}).strict();

export const RunActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stop") }).strict(),
  z.object({ type: z.literal("retry") }).strict(),
  z.object({ type: z.literal("open_workspace") }).strict(),
]);

export type SymphonyRunStatus = z.infer<typeof SymphonyRunStatusSchema>;
export type SymphonyAgent = z.infer<typeof SymphonyAgentSchema>;
export type SymphonyInstallationInput = z.infer<typeof SymphonyInstallationInputSchema>;
export type SymphonyRuleInput = z.infer<typeof SymphonyRuleInputSchema>;
export type SaveSymphonyConfigInput = z.infer<typeof SaveSymphonyConfigSchema>;
export type RunAction = z.infer<typeof RunActionSchema>;

export interface SymphonyInstallation extends SymphonyInstallationInput {
  id: string;
  ownerId: string;
  enabled: boolean;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TicketSourceRule extends SymphonyRuleInput {
  installationId: string;
  updatedAt: string;
}

export interface MatrixProjectOption {
  slug: string;
  name: string;
  repositoryUrl?: string;
  updatedAt?: string;
}

export interface LinearTeamOption {
  id: string;
  key: string;
  name: string;
}

export interface LinearProjectOption {
  id: string;
  name: string;
  slug?: string;
  teamIds: string[];
}

export interface LinearUserOption {
  id: string;
  name: string;
  displayName?: string;
  active?: boolean;
}

export interface LinearSetupOptions {
  teams: LinearTeamOption[];
  projects: LinearProjectOption[];
  users: LinearUserOption[];
}

export interface TrackedTicket {
  sourceKind?: "linear" | "matrix";
  externalId: string;
  identifier: string;
  title: string;
  url?: string;
  teamId?: string;
  teamKey?: string;
  projectId?: string;
  projectSlug?: string;
  stateName: string;
  stateType?: string;
  assigneeId?: string;
  assigneeName?: string;
  labels: string[];
  priority?: number | null;
  branchName?: string | null;
  updatedAt?: string;
}

export interface SymphonyRun {
  id: string;
  installationId: string;
  ticketExternalId: string;
  ticketSourceKind?: "linear" | "matrix";
  trackedTicketId?: string;
  ticketIdentifier: string;
  ticketTitle: string;
  ticketUrl?: string;
  status: SymphonyRunStatus;
  attempt: number;
  agent: SymphonyAgent;
  projectSlug: string;
  worktreeId?: string;
  worktreePath?: string;
  sessionId?: string;
  claimKey: string;
  lastEvent: string;
  lastErrorCode?: string;
  nextRetryAt?: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
}

export const ManualTicketAssignmentSchema = z.object({
  sourceKind: z.enum(["linear", "matrix"]).default("matrix"),
  externalId: z.string().trim().min(1).max(256),
  identifier: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(300),
  url: z.string().url().optional(),
  stateName: z.string().trim().min(1).max(64).default("Todo"),
  assigneeId: z.string().trim().min(1).max(128).optional(),
  assigneeName: z.string().trim().max(200).optional(),
  labels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  branchName: z.string().trim().max(200).optional(),
}).strict();

export type ManualTicketAssignment = z.infer<typeof ManualTicketAssignmentSchema>;

export interface CodexReadiness {
  status: "valid" | "missing" | "unknown";
  lastCheckedAt?: string;
}

export interface OperatorEvent {
  id: string;
  installationId: string;
  runId?: string;
  type: string;
  message: string;
  severity: "info" | "warning" | "error";
  actorId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface SymphonySnapshot {
  installation: SymphonyInstallation | null;
  rule: TicketSourceRule | null;
  runs: SymphonyRun[];
  events: OperatorEvent[];
  lastPollAt: string | null;
}

export function sanitizeLabels(labels: string[]): string[] {
  return Array.from(new Set(labels.map((label) => label.trim()).filter(Boolean))).slice(0, 20);
}

export function genericSymphonyError(code = "symphony_request_failed", message = "Symphony request failed") {
  return { error: { code, message } };
}
