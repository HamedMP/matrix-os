# Contract: Hermes Bridge

The gateway uses a typed `HermesBridge` so routes never shell out or call upstream Hermes endpoints directly.

## Dependency Resolution

All required dependencies are resolved when the bridge is created:

- Hermes repository or CLI path.
- Owner-scoped Hermes home.
- Process runner with timeout support.
- Optional local API endpoint.
- Optional session WebSocket endpoint.
- Credential store.
- Logger.

Creation fails with a server-side diagnostic if a required dependency is missing. Routes return a generic unavailable response.

## Startup Sequence

Gateway startup wires Hermes Manager in this order:

1. `new KyselyHermesRepository(kyselyInstance)` is created only when owner Postgres is available.
2. `repository.bootstrap()` creates or verifies the Hermes Manager state table before routes are mounted.
3. `createFileHermesCredentialStore({ homePath })` resolves the owner home credential directory.
4. `createHermesEventHub()` creates bounded in-process event/subscriber retention.
5. `createLocalHermesBridge({ homePath })` resolves Hermes CLI/API dependencies and timeout runner configuration.
6. `createHermesRoutes({ repository, credentialStore, bridge, eventHub })` registers `/api/hermes`.
7. If any required startup dependency is unavailable, gateway mounts an unavailable `/api/hermes/*` router that returns generic `503 hermes_unavailable`; it must not partially mount live routes with undefined dependencies.

## Interface

```ts
type OwnerContext = {
  ownerId: string;
  installation: {
    id: string;
    ownerId: string;
    readiness: "missing" | "installed" | "configuring" | "degraded" | "ready" | "updating" | "needs_attention";
    gatewayStatus: "unknown" | "stopped" | "starting" | "healthy" | "degraded" | "failed";
    defaultProfileId: string;
    defaultModelId?: string;
    authorizedOperators: string[];
  } | null;
};

type RecoveryInput = OwnerContext & {
  scope?: "installation";
};

type RecoveryResult = {
  status: "complete" | "degraded" | "failed";
  message: string;
};

type HermesStatusResult = {
  installationId: string | null;
  readiness: "missing" | "installed" | "configuring" | "degraded" | "ready" | "updating" | "needs_attention";
  gatewayStatus: "unknown" | "stopped" | "starting" | "healthy" | "degraded" | "failed";
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
};

type HermesInstallationPatch = Partial<NonNullable<OwnerContext["installation"]>> & {
  hermesPathLabel?: string | null;
  version?: string | null;
  lastCheckedAt: string;
};

// hermesPathLabel is a private, redacted installation-state patch field. Route
// handlers may persist it to the owner installation record, but must not spread
// it into the public HermesStatusResult response. The public status response
// exposes installationId, readiness, gatewayStatus, counts, version, model/profile
// identifiers, and lastCheckedAt only.

type HermesConfigResult = {
  installation: NonNullable<OwnerContext["installation"]> | null;
  setupSteps: HermesSetupStepDto[];
  modelProviders: ModelCredentialResult[];
  capabilities: HermesCapabilityDto[];
  channels: MessagingChannelDto[];
};

type HermesSetupStepDto = {
  id: string;
  status: "pending" | "active" | "complete" | "failed" | "skipped";
  required: boolean;
  title: string;
  detail: string;
  recoveryAction?: string;
  updatedAt: string;
};

type SaveConfigInput = OwnerContext & {
  config: {
    homeMode: "default" | "custom";
    hermesPath?: string;
    defaultProfileId: string;
    defaultModelId?: string;
    authorizedOperators: string[];
  };
};

type SaveModelCredentialInput = OwnerContext & {
  credential: {
    providerId: string;
    secret: string;
  };
};

type ModelCredentialResult = {
  id: string;
  configured: boolean;
  status: "unknown" | "validating" | "healthy" | "failed";
  availableModels: Array<{ id: string; label: string }>;
  lastCheckedAt: string | null;
};

type ModelCredentialSaveResponse = {
  configured: boolean;
  providerId: string;
  status: ModelCredentialResult["status"];
};

// ModelCredentialSaveResponse is a REST route mapper result, not the bridge
// return type. The bridge/repository canonical provider key is id; POST
// /credentials/model maps id to providerId for the one-shot save response.

type MessagingChannelDto = {
  id: string;
  platform: "telegram" | "whatsapp" | "discord" | "slack" | "matrix" | "other";
  enabled: boolean;
  configured: boolean;
  status: "disconnected" | "pairing" | "connected" | "degraded" | "disabled" | "failed";
  allowedSenderPolicy: string;
  homeChannel?: string;
  lastCheckedAt: string | null;
  updatedAt: string;
};

// id is the canonical Hermes channel key used by routes and persisted state.
// platform is the provider family. P1 mutating routes only allow id values
// "telegram" and "whatsapp", but read-only channel lists may include future
// channel ids with platform "discord" | "slack" | "matrix" | "other".

type ChannelActionInput = OwnerContext & {
  channelId: "telegram" | "whatsapp";
  action: { type: "connect" | "verify" | "disable" | "enable" | "recover" | "start_pairing" | "cancel_pairing"; payload?: Record<string, unknown> };
};

type ChannelActionBridgeResult = {
  channel: MessagingChannelDto;
  pairing?: {
    kind: "qr" | "code";
    displayValue: string;
    expiresAt: string;
  };
};

type ChannelActionResult = {
  channel: MessagingChannelDto;
  operation: {
    id: string;
    status: "running" | "complete" | "failed";
    message: string;
    pairing?: {
      kind: "qr" | "code";
      displayValue: string;
      expiresAt: string;
    };
  };
};

// The bridge returns ChannelActionBridgeResult. The route persists result.channel
// and then wraps it into the REST ChannelActionResult { channel, operation }.
// The route generates operation.id as an opaque op_* reference, sets
// operation.status to "complete" when the bridge returns successfully, and uses
// a client-safe channel-action message such as "Channel updated". For WhatsApp
// start_pairing, result.pairing is the only source for operation.pairing display
// data; routes must not synthesize QR/code values.

type HermesCapabilityDto = {
  id: string;
  kind: "profile" | "skill" | "toolset" | "gateway" | "channel";
  name: string;
  enabled: boolean;
  status: "available" | "missing_setup" | "disabled" | "failed";
  description: string;
  updatedAt: string;
};

type GatewayActionInput = OwnerContext & {
  action: { type: "restart" | "health_check" | "update" };
};

type GatewayActionResult = {
  id: string;
  status: "running" | "complete";
  message: string;
  patch?: Partial<NonNullable<OwnerContext["installation"]>>;
};

type HermesSessionDto = {
  id: string;
  hermesSessionId: string;
  installationId: string;
  ownerId: string;
  operatorId: string;
  profileId: string;
  modelId?: string;
  status: "idle" | "starting" | "streaming" | "waiting_approval" | "stopped" | "failed" | "recoverable";
  clientRequestIds: string[];
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
};

type CreateSessionInput = OwnerContext & {
  operatorId: string;
  payload: {
    profileId: string;
    modelId?: string;
    prompt: string;
    clientRequestId: string;
  };
};

type SendPromptInput = OwnerContext & {
  operatorId: string;
  session: HermesSessionDto;
  payload: {
    prompt: string;
    clientRequestId: string;
  };
};

type ApprovalPromptDto = {
  id: string;
  hermesApprovalId: string;
  sessionId: string;
  status: "pending" | "approved" | "denied" | "expired" | "failed";
  description: string;
  requestedTool?: string;
  decisionBy: string | null;
  decisionAt: string | null;
  createdAt: string;
};

type ApprovalDecisionInput = OwnerContext & {
  operatorId: string;
  approval: ApprovalPromptDto;
  payload: { decision: "approved" | "denied" };
};

interface HermesBridge {
  // Bridge status is an installation patch. The route composes the public
  // HermesStatusResult, including installationId and counts, from repository state.
  getStatus(input: OwnerContext): Promise<HermesInstallationPatch>;
  readConfig(input: OwnerContext): Promise<HermesConfigResult>;
  saveConfig(input: SaveConfigInput): Promise<HermesConfigResult>;
  saveModelCredential(input: SaveModelCredentialInput): Promise<ModelCredentialResult>;
  listChannels(input: OwnerContext): Promise<MessagingChannelDto[]>;
  runChannelAction(input: ChannelActionInput): Promise<ChannelActionBridgeResult>;
  listCapabilities(input: OwnerContext): Promise<HermesCapabilityDto[]>;
  runGatewayAction(input: GatewayActionInput): Promise<GatewayActionResult>;
  createSession(input: CreateSessionInput): Promise<HermesSessionDto>;
  sendPrompt(input: SendPromptInput): Promise<HermesSessionDto>;
  decideApproval(input: ApprovalDecisionInput): Promise<ApprovalPromptDto>;
  recover(input: RecoveryInput): Promise<RecoveryResult>;
}
```

## Error Policy

- Bridge methods throw typed errors: `unavailable`, `timeout`, `invalid_upstream_response`, `operation_failed`, `conflict`, `unauthorized`.
- Route mappers convert typed errors to generic client messages.
- Raw Hermes stderr/stdout, provider responses, paths, and stack traces are logged server-side only.

## Timeout Policy

- Status/config/model list: 10 seconds.
- Channel verify/connect/pairing poll: 30 seconds per step.
- Gateway restart: 45 seconds.
- Hermes update: operation event stream with 60 second heartbeat and server-side max duration.
- Session prompt submit: 10 seconds to enqueue, streaming continues through event hub with heartbeat.

## Redaction Policy

Bridge DTOs returned to routes must already be redacted. Routes perform a second shape validation before responding to clients.

Forbidden public fields:

- `secret`, `token`, `apiKey`, `password`, `env`, `stderr`, `stdout`, `stack`, `path`, `homePath`, `repoPath`, `hermesPath`.

## Upstream Drift

If Hermes local API or WebSocket responses miss required fields, bridge returns `invalid_upstream_response`, marks readiness `needs_attention` where safe, and records a redacted operator event.
