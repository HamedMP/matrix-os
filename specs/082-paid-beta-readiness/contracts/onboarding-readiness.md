# Contract: Onboarding And Launch Readiness

## Auth And Error Policy

All routes are owner-authenticated through the Matrix request principal unless explicitly marked operator-only. Browser-visible errors use generic codes and safe messages. Server logs may contain provider details; client responses must not include provider secrets, raw provider errors, database errors, or filesystem paths.

All mutating endpoints use Hono `bodyLimit`. Request bodies, query params, route params, and WebSocket frames are validated with Zod 4 at the boundary.

## WebSocket: `/ws/onboarding`

Extends the existing onboarding WebSocket.

### Shell To Gateway Messages

```ts
type MatrixActivationClientMessage =
  | { type: "start"; audioFormat: "pcm16" | "text" }
  | { type: "select_goal"; goalId: "coding" | "app_building" | "company_brain" | "assistant" }
  | { type: "complete_step"; stepId: string }
  | { type: "skip_step"; stepId: string; reason?: string }
  | { type: "retry_gate"; gateId: string }
  | { type: "choose_activation"; path: "api_key" | "claude_code" | "hermes" | "codex" }
  | { type: "approve_capability"; capabilityId: string; agent: "claude" | "codex" | "hermes" }
  | { type: "audio"; data: string }
  | { type: "text_input"; text: string };
```

### Gateway To Shell Messages

```ts
type MatrixActivationServerMessage =
  | { type: "stage"; stage: string; audioSource?: "gemini_live" | "tts" }
  | { type: "goal_selected"; goalId: string; steps: OnboardingStepSummary[] }
  | { type: "readiness_update"; checklist: ReadinessGateSummary[]; overallStatus: "ready" | "degraded" | "blocked" | "checking" }
  | { type: "agent_status"; agents: AgentCredentialSummary[]; systemAgent: "hermes"; activeAgents: ("claude" | "codex" | "hermes")[] }
  | { type: "integration_status"; capabilities: IntegrationCapabilitySummary[] }
  | { type: "visual_system"; version: string; reducedMotion: boolean }
  | { type: "safe_action_summary"; action: AgentActionSummary }
  | { type: "contextual_content"; content: ContextualContent }
  | { type: "error"; code: string; stage: string; message: string; retryable: boolean };
```

### Resource Limits

- Text frames: capped to the existing onboarding max text size.
- Audio frames: capped to the existing onboarding max audio size.
- Session audio: capped to the existing onboarding session max.
- Unknown message types: rejected with a generic invalid-message error.

## REST: Readiness

### `GET /api/onboarding/readiness`

Returns the owner-scoped activation checklist.

**Auth**: owner user.

**Response 200**:

```json
{
  "overallStatus": "ready",
  "goals": [
    { "id": "coding", "selected": true, "label": "Code with Matrix" }
  ],
  "gates": [
    {
      "id": "github.connected",
      "category": "integration",
      "criticality": "goal_required",
      "status": "pass",
      "message": "GitHub is connected",
      "remediation": null,
      "owner": "user",
      "lastCheckedAt": "2026-05-23T00:00:00.000Z"
    }
  ]
}
```

### `POST /api/onboarding/goals`

Persists selected onboarding goals and returns tailored steps.

**Auth**: owner user.
**Body limit**: small JSON body.

**Request**:

```json
{ "goalIds": ["coding", "assistant"] }
```

**Response 200**:

```json
{
  "goalIds": ["coding", "assistant"],
  "steps": [
    { "id": "connect-github", "required": true, "title": "Connect GitHub", "unlocks": ["coding"] }
  ]
}
```

### `POST /api/onboarding/gates/:gateId/retry`

Retries a retryable readiness gate.

**Auth**: owner user.
**Body limit**: empty or tiny JSON body.

**Response 202**:

```json
{ "gateId": "terminal.ready", "status": "checking" }
```

## REST: Agent Credentials

### `GET /api/agents/credentials/status`

Returns user-visible agent availability and routing explanation.

**Auth**: owner user.

**Response 200**:

```json
{
  "systemAgent": "hermes",
  "activeAgents": ["hermes"],
  "agents": [
    { "agent": "claude", "status": "missing", "workflows": ["core_agent"], "nextAction": "Connect Claude to enable the core agent path" },
    { "agent": "codex", "status": "missing", "workflows": ["coding"], "nextAction": "Connect Codex for optional coding support" },
    { "agent": "hermes", "status": "available", "workflows": ["app_building", "assistant", "integrations"], "nextAction": null }
  ]
}
```

When Claude or Codex are connected, `activeAgents` is additive. Hermes remains `systemAgent` and remains available for supported system workflows.

### `POST /api/agents/credentials/:agent/verify`

Verifies a user-selected credential path without exposing credential details.

**Auth**: owner user.
**Body limit**: small JSON body.
**Allowed `agent` values**: `claude`, `codex`, `hermes`.

**Response 200**:

```json
{ "agent": "claude", "status": "available", "verifiedAt": "2026-05-23T00:00:00.000Z" }
```

## REST: Integration Capabilities

### `GET /api/integrations/capabilities`

Returns approved, missing, revoked, or unavailable capabilities for the owner.

**Auth**: owner user.

**Response 200**:

```json
{
  "capabilities": [
    {
      "id": "calendar.create_event",
      "provider": "calendar",
      "capability": "create_calendar_event",
      "status": "approved",
      "approvedAgents": ["hermes"],
      "requiresApprovalPerAction": true
    }
  ]
}
```

### `POST /api/integrations/capabilities/:capabilityId/approval`

Approves or revokes a capability for an agent.

**Auth**: owner user.
**Body limit**: small JSON body.

**Request**:

```json
{ "agent": "hermes", "approved": true }
```

**Response 200**:

```json
{ "capabilityId": "calendar.create_event", "agent": "hermes", "status": "approved" }
```

## REST: Admin Control Surface

### `GET /api/admin/control-surface`

Returns owner-visible model, settings, integration, automation, activity, and readiness summaries for the Matrix admin/control surface.

**Auth**: owner user or authorized operator.

**Response 200**:

```json
{
  "sections": ["models", "agents", "integrations", "settings", "automations", "activity", "readiness"],
  "providers": [
    {
      "id": "claude",
      "label": "Claude",
      "status": "missing",
      "mode": "bring_your_own",
      "nextAction": "Connect Claude for the core agent path"
    },
    {
      "id": "hermes",
      "label": "Hermes",
      "status": "available",
      "mode": "matrix_system_agent",
      "nextAction": null
    }
  ],
  "automationSummary": {
    "active": 2,
    "needsApproval": 1,
    "lastActivityAt": "2026-05-23T00:00:00.000Z"
  }
}
```

### `POST /api/admin/control-surface/setup-session`

Creates or resumes a setup wizard session for model/provider, integration, setting, or automation setup.

**Auth**: owner user.
**Body limit**: small JSON body.

**Request**:

```json
{ "section": "models", "resume": true }
```

**Response 200**:

```json
{ "sessionId": "setup_123", "status": "running", "currentStepId": "choose-provider" }
```

## REST: Operator Readiness

### `GET /api/operator/launch-readiness`

Returns launch gates for a fresh workspace rehearsal and an existing workspace rehearsal.

**Auth**: authorized operator only.

**Response 200**:

```json
{
  "launchReady": false,
  "gates": [
    {
      "id": "onboarding.visual_qa",
      "status": "fail",
      "owner": "matrix",
      "message": "Onboarding visual QA has not passed",
      "remediation": "Run desktop and mobile visual QA"
    }
  ]
}
```

## Visual QA Contract

The onboarding implementation must produce review evidence for:

- Desktop viewport.
- Mobile viewport.
- Reduced-motion mode.
- Missing media fallback.
- No-Claude Hermes path.
- Connected Claude/Codex path where Hermes remains available.
- Admin/control surface model, settings, automation, activity, and readiness views.
- GitHub/coding setup path.
- Calendar/email assistant setup path.

Failure to produce this evidence keeps `onboarding.visual_qa` in `fail` or `blocked`.
