import { z } from "zod/v4";

export const HERMES_APP_ID = "hermes-manager";
export const HERMES_BODY_LIMIT = 64 * 1024;
export const HERMES_EMPTY_BODY_LIMIT = 4 * 1024;
export const MAX_HERMES_EVENTS = 500;
export const MAX_HERMES_SESSIONS = 100;
export const MAX_HERMES_APPROVALS = 100;
export const MAX_HERMES_OPERATORS = 50;
export const MAX_HERMES_CHANNELS = 20;
export const MAX_HERMES_MODEL_PROVIDERS = 20;
export const MAX_HERMES_CAPABILITIES = 200;
export const MAX_HERMES_SUBSCRIBERS = 100;
export const HERMES_SUBSCRIBER_TTL_MS = 2 * 60_000;

export const HermesReadinessSchema = z.enum(["missing", "installed", "configuring", "degraded", "ready", "updating", "needs_attention"]);
export const HermesGatewayStatusSchema = z.enum(["unknown", "stopped", "starting", "healthy", "degraded", "failed"]);
export const HermesChannelPlatformSchema = z.enum(["telegram", "whatsapp", "discord", "slack", "matrix", "other"]);
export const HermesChannelStatusSchema = z.enum(["disconnected", "pairing", "connected", "degraded", "disabled", "failed"]);
export const HermesSessionStatusSchema = z.enum(["idle", "starting", "streaming", "waiting_approval", "stopped", "failed", "recoverable"]);
export const HermesApprovalStatusSchema = z.enum(["pending", "approved", "denied", "expired", "failed"]);
export const HermesCapabilityKindSchema = z.enum(["profile", "skill", "toolset", "gateway", "channel"]);
export const HermesCapabilityStatusSchema = z.enum(["available", "missing_setup", "disabled", "failed"]);

const SafeId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:@=-]+$/);
const SafeSlug = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const BoundedString = z.string().trim().min(1).max(512);
const OptionalBoundedString = z.string().trim().max(512).optional();
const MatrixUserId = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_@:.=-]+$/);

export const HermesConfigInputSchema = z.object({
  homeMode: z.enum(["default", "custom"]).optional(),
  hermesPath: z.string().trim().min(1).max(512).optional(),
  defaultProfileId: SafeSlug.optional(),
  defaultModelId: SafeSlug.optional(),
  authorizedOperators: z.array(MatrixUserId).max(MAX_HERMES_OPERATORS).optional(),
}).strict().refine((input) => !input.hermesPath || input.homeMode === "custom", {
  message: "hermesPath requires homeMode to be custom",
  path: ["hermesPath"],
});

export const ModelCredentialInputSchema = z.object({
  providerId: SafeSlug,
  secret: z.string().trim().min(1).max(8192),
}).strict();

export const ChannelActionInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connect"),
    payload: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  z.object({ type: z.literal("verify") }).strict(),
  z.object({ type: z.literal("disable") }).strict(),
  z.object({ type: z.literal("enable") }).strict(),
  z.object({ type: z.literal("recover") }).strict(),
  z.object({
    type: z.literal("start_pairing"),
    payload: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
  z.object({ type: z.literal("cancel_pairing") }).strict(),
]);

export const SessionQuerySchema = z.object({
  status: HermesSessionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_HERMES_SESSIONS).default(MAX_HERMES_SESSIONS),
  cursor: z.string().trim().min(1).max(256).optional(),
}).strict();

export const CreateSessionInputSchema = z.object({
  profileId: SafeSlug.default("default"),
  modelId: SafeSlug.optional(),
  prompt: z.string().trim().min(1).max(32_000),
  clientRequestId: SafeId,
}).strict();

export const SendPromptInputSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  clientRequestId: SafeId.optional(),
}).strict();

export const ApprovalDecisionInputSchema = z.object({
  decision: z.enum(["approved", "denied"]),
}).strict();

export const GatewayActionInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("restart") }).strict(),
  z.object({ type: z.literal("health_check") }).strict(),
  z.object({ type: z.literal("update") }).strict(),
]);

export const EmptyBodySchema = z.object({}).strict();
export const OwnerScopeQuerySchema = z.object({ ownerId: MatrixUserId.optional() }).passthrough();
export const PathIdParamSchema = z.object({ id: SafeId });
export const ChannelIdParamSchema = z.object({ channelId: z.enum(["telegram", "whatsapp"]) });
export const ApprovalIdParamSchema = z.object({ approvalId: SafeId });
export const SessionIdParamSchema = z.object({ sessionId: SafeId });

export type HermesReadiness = z.infer<typeof HermesReadinessSchema>;
export type HermesGatewayStatus = z.infer<typeof HermesGatewayStatusSchema>;
export type HermesChannelPlatform = z.infer<typeof HermesChannelPlatformSchema>;
export type HermesChannelStatus = z.infer<typeof HermesChannelStatusSchema>;
export type HermesSessionStatus = z.infer<typeof HermesSessionStatusSchema>;
export type HermesApprovalStatus = z.infer<typeof HermesApprovalStatusSchema>;
export type HermesConfigInput = z.infer<typeof HermesConfigInputSchema>;
export type ModelCredentialInput = z.infer<typeof ModelCredentialInputSchema>;
export type ChannelActionInput = z.infer<typeof ChannelActionInputSchema>;
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;
export type SendPromptInput = z.infer<typeof SendPromptInputSchema>;
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;
export type GatewayActionInput = z.infer<typeof GatewayActionInputSchema>;

export interface HermesInstallation {
  id: string;
  ownerId: string;
  homeMode: "default" | "custom";
  hermesPathLabel: string | null;
  version: string | null;
  readiness: HermesReadiness;
  gatewayStatus: HermesGatewayStatus;
  defaultProfileId: string;
  defaultModelId?: string;
  authorizedOperators: string[];
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
}

export interface HermesSetupStep {
  id: string;
  status: "pending" | "active" | "complete" | "failed" | "skipped";
  required: boolean;
  title: string;
  detail: string;
  recoveryAction?: string;
  updatedAt: string;
}

export interface ModelProviderConnection {
  id: string;
  configured: boolean;
  status: "unknown" | "validating" | "healthy" | "failed";
  defaultModelId?: string;
  availableModels: Array<{ id: string; label: string }>;
  lastCheckedAt: string | null;
}

export interface MessagingChannel {
  id: string;
  platform: z.infer<typeof HermesChannelPlatformSchema>;
  enabled: boolean;
  configured: boolean;
  status: z.infer<typeof HermesChannelStatusSchema>;
  allowedSenderPolicy: string;
  homeChannel?: string;
  lastCheckedAt: string | null;
  updatedAt: string;
}

export interface HermesSession {
  id: string;
  hermesSessionId: string;
  installationId: string;
  ownerId: string;
  operatorId: string;
  profileId: string;
  modelId?: string;
  status: z.infer<typeof HermesSessionStatusSchema>;
  lastEventId?: string;
  clientRequestIds?: string[];
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export interface ApprovalPrompt {
  id: string;
  hermesApprovalId: string;
  sessionId: string;
  status: z.infer<typeof HermesApprovalStatusSchema>;
  description: string;
  requestedTool?: string;
  decisionBy: string | null;
  decisionAt: string | null;
  createdAt: string;
}

export interface HermesCapability {
  id: string;
  kind: z.infer<typeof HermesCapabilityKindSchema>;
  name: string;
  enabled: boolean;
  status: z.infer<typeof HermesCapabilityStatusSchema>;
  description: string;
  updatedAt: string;
}

export interface OperatorEvent {
  id: string;
  installationId: string;
  actorId?: string;
  category: "setup" | "credential" | "channel" | "session" | "approval" | "gateway" | "update" | "recovery";
  targetId?: string;
  severity: "info" | "warning" | "error";
  message: string;
  createdAt: string;
}

export interface HermesStreamEvent {
  id: string;
  type: "status.updated" | "channel.updated" | "session.event" | "approval.updated" | "operator.event" | "heartbeat";
  installationId?: string;
  sessionId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface HermesSnapshot {
  installation: HermesInstallation | null;
  setupSteps: HermesSetupStep[];
  modelProviders: ModelProviderConnection[];
  channels: MessagingChannel[];
  sessions: HermesSession[];
  approvals: ApprovalPrompt[];
  capabilities: HermesCapability[];
  events: OperatorEvent[];
}

export interface HermesStatusResponse {
  installationId: string | null;
  readiness: HermesReadiness;
  gatewayStatus: HermesGatewayStatus;
  version: string | null;
  defaultProfileId: string | null;
  defaultModelId?: string;
  counts: {
    channels: number;
    connectedChannels: number;
    activeSessions: number;
    pendingApprovals: number;
    needsAttention: number;
  };
  lastCheckedAt: string | null;
}

export function genericHermesError(code = "hermes_request_failed", message = "Hermes request failed") {
  return { error: { code, message } };
}

const FORBIDDEN_PUBLIC_KEYS = new Set(["secret", "token", "apiKey", "password", "env", "stderr", "stdout", "stack", "path", "homePath", "repoPath"]);

export function assertNoHermesSecretFields(value: unknown): void {
  const visit = (input: unknown): void => {
    if (!input || typeof input !== "object") return;
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(input)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) {
        throw new Error(`Forbidden public Hermes field: ${key}`);
      }
      visit(child);
    }
  };
  visit(value);
}

export function redactLabel(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1)?.slice(0, 80) ?? "configured";
}

export function defaultHermesInstallation(ownerId: string): HermesInstallation {
  const now = new Date().toISOString();
  return {
    id: `hermes_${ownerId}`,
    ownerId,
    homeMode: "default",
    hermesPathLabel: null,
    version: null,
    readiness: "missing",
    gatewayStatus: "unknown",
    defaultProfileId: "default",
    authorizedOperators: [],
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: null,
  };
}

export function defaultSetupSteps(now = new Date().toISOString()): HermesSetupStep[] {
  return [
    { id: "installation", status: "pending", required: true, title: "Install Hermes", detail: "Hermes is not ready yet", updatedAt: now },
    { id: "model", status: "pending", required: true, title: "Connect model", detail: "Model provider needs setup", updatedAt: now },
    { id: "channel", status: "pending", required: true, title: "Connect channel", detail: "Connect Telegram or WhatsApp", updatedAt: now },
  ];
}

export function publicSnapshot(snapshot: HermesSnapshot) {
  const result = {
    installation: snapshot.installation,
    setupSteps: snapshot.setupSteps,
    modelProviders: snapshot.modelProviders,
    channels: snapshot.channels,
    capabilities: snapshot.capabilities,
    sessions: snapshot.sessions,
    approvals: snapshot.approvals,
    events: snapshot.events,
  };
  assertNoHermesSecretFields(result);
  return result;
}

export function buildStatus(snapshot: HermesSnapshot): HermesStatusResponse {
  const installation = snapshot.installation;
  return {
    installationId: installation?.id ?? null,
    readiness: installation?.readiness ?? "missing",
    gatewayStatus: installation?.gatewayStatus ?? "unknown",
    version: installation?.version ?? null,
    defaultProfileId: installation?.defaultProfileId ?? null,
    defaultModelId: installation?.defaultModelId,
    counts: {
      channels: snapshot.channels.length,
      connectedChannels: snapshot.channels.filter((channel) => channel.status === "connected" && channel.enabled).length,
      activeSessions: snapshot.sessions.filter((session) => ["starting", "streaming", "waiting_approval"].includes(session.status)).length,
      pendingApprovals: snapshot.approvals.filter((approval) => approval.status === "pending").length,
      needsAttention: [
        installation?.readiness === "needs_attention" ? 1 : 0,
        snapshot.channels.filter((channel) => channel.status === "failed" || channel.status === "degraded").length,
        snapshot.sessions.filter((session) => session.status === "failed" || session.status === "recoverable").length,
      ].reduce((sum, count) => sum + count, 0),
    },
    lastCheckedAt: installation?.lastCheckedAt ?? null,
  };
}

export function isHermesActiveSession(status: HermesSession["status"]): boolean {
  return status === "starting" || status === "streaming" || status === "waiting_approval";
}

export function safeMessage(message: string | undefined, fallback = "Hermes request failed"): string {
  if (!message) return fallback;
  if (message.length > 160) return fallback;
  if (/[\\/](home|tmp|var|opt|Users)[\\/]/.test(message)) return fallback;
  if (/token|secret|api[_-]?key|password|stack|trace|stderr|stdout/i.test(message)) return fallback;
  return message;
}

export type BoundedStringValue = z.infer<typeof BoundedString>;
export type OptionalBoundedStringValue = z.infer<typeof OptionalBoundedString>;
