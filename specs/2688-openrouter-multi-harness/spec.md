# Feature Specification: Shared OpenRouter Routing

**Feature Branch**: `codex/eng-381-openrouter-routing`  
**Created**: 2026-10-24  
**Status**: Approved for implementation; live qualification remains gated  
**Tracking**: [ENG-381](https://linear.app/matrix-os/issue/ENG-381/featai-add-shared-openrouter-routing-for-chat-and-coding-agents)  
**Predecessor**: [`specs/118-ai-gateway-provider-auth`](../118-ai-gateway-provider-auth/spec.md)

## Product intent

An owner connects one OpenRouter API key in **Agents & providers** and can then
select four independently runnable, owner-funded paths:

- `matrix_pi_owner_openrouter`
- `kernel_owner_openrouter`
- `claude_code_owner_openrouter`
- `codex_owner_openrouter`

The route is always explicit. Matrix never substitutes Matrix credit, an
Anthropic key/profile, ChatGPT, OpenAI, or another local tool credential when an
OpenRouter start or resume fails. Pi, OpenCode, Hermes, and other native stores
remain untouched.

## User stories

### US1 — Connect once and reuse everywhere (P1)

An owner enters an OpenRouter key once and immediately sees the same account on
all four compatible harness instances without the key entering client state.

**Independent test**: connect a valid fixture credential through the existing
key workflow, refresh the provider snapshot, and assert all four instances bind
the same account and credential generation.

### US2 — Choose an exact qualified route (P1)

An owner selects a curated exact model for a specific harness and sees who is
billed before starting a turn.

**Independent test**: select each advertised route and assert the execution
fingerprint contains the instance, access source, account, generation, and exact
model. Remove the model from live availability and assert the saved selection is
visible but cannot execute.

### US3 — Run without credential bleed (P1)

Matrix AI, the kernel, Claude Code, and Codex can each run with only the selected
OpenRouter credential and an isolated Matrix-managed profile.

**Independent test**: populate native Claude/Codex/OpenAI/Anthropic credentials
with sentinels, run each launch contract, and prove no sentinel reaches the
child, arguments, generated configuration, logs, errors, or snapshots.

### US4 — Rotate or revoke safely (P1)

Rotating a key increments its generation and terminates runs using the old
generation. Disconnect prevents starts and resumes, drains OpenRouter children,
and keeps conversation history readable.

**Independent test**: race start/resume against rotate/disconnect and assert
fail-closed generation checks before admission and immediately before launch.

## Functional requirements

- **FR-001**: `owner_openrouter` MUST represent one canonical owner account and
  one canonical owner API-key credential.
- **FR-002**: The credential MUST use the owner-controlled file lifecycle under
  `system/ai-providers/`: restrictive permissions, symlink-safe reads/writes,
  atomic replacement, monotonically changing generation, and tombstoned revoke.
- **FR-003**: Durable account/profile changes related to a key mutation MUST
  commit transactionally with the staged file mutation.
- **FR-004**: The existing authenticated, body-limited
  `POST /api/ai/provider-settings/workflows/v2/keys` workflow MUST be the only
  key-management API.
- **FR-005**: Verification MUST call OpenRouter's fixed key endpoint with a
  10-second timeout, `redirect: "error"`, bounded response handling, and generic
  client errors.
- **FR-006**: Secrets MUST NOT appear in client state, telemetry, logs, command
  arguments, generated config, snapshots, or provider-facing errors.
- **FR-007**: The provider snapshot MUST publish the four stable instance IDs
  above, all bound to the same account and access source.
- **FR-008**: A checked-in compatibility matrix MUST contain only exact model
  slugs; `openrouter/auto`, moving aliases, and unqualified models are forbidden.
- **FR-009**: A bounded TTL catalog check MAY hide a curated model that the
  provider no longer lists. A selected removed model remains visible as
  unavailable and blocks execution.
- **FR-010**: Start and resume MUST recheck the feature flag, access-source
  readiness, credential generation, selected model, and exact binding.
- **FR-011**: The execution fingerprint MUST preserve instance, provider,
  account, access source, credential generation, and exact model.
- **FR-012**: Matrix Pi MUST receive a per-launch portable credential derived
  from the canonical key; Matrix MUST NOT write it to Pi's native auth store.
- **FR-013**: Kernel and Claude Code launches MUST use an isolated
  Matrix-managed Claude profile and the fixed OpenRouter Anthropic endpoint.
- **FR-014**: Codex MUST use an isolated Matrix-managed profile, Responses API,
  non-secret generated provider config, and a child-only environment variable.
- **FR-015**: User `~/.claude` and `~/.codex` profiles MUST remain unchanged.
- **FR-016**: Settings and Chat MUST reuse the canonical provider snapshot and
  model picker, preserve drafts, label the route “Billed by OpenRouter”, and
  never infer a balance.
- **FR-017**: Disconnect MUST be blocked while this account is a default until
  the owner explicitly reassigns the default.
- **FR-018**: A single operational capability flag MUST disable new starts and
  resumes without deleting account metadata, settings, or history. It is off by
  default outside development/test.
- **FR-019**: OpenRouter OAuth, organization funding/budgets, automatic secret
  migration, the full catalog, and automatic provider fallback are out of scope.

## Compatibility matrix

These are release candidates, not production-qualified claims. The operational
flag remains disabled until the live suite in `research.md` passes on the exact
pinned binaries.

| Harness | Exact model slug | Required qualification |
|---|---|---|
| Matrix AI (Pi) | `anthropic/claude-sonnet-5` | stream, Matrix tools, cancel, resume |
| Matrix AI (Pi) | `openai/gpt-5.6-luna` | stream, Matrix tools, cancel, resume |
| Matrix AI (Pi) | `openai/gpt-5.6-sol` | stream, Matrix tools, cancel, resume |
| Kernel | `anthropic/claude-sonnet-5` | SDK tools, cancel, `query()` resume |
| Claude Code | `anthropic/claude-sonnet-5` | tools, cancel, CLI resume |
| Codex | `openai/gpt-5.6-luna` | Responses stream, tools, cancel, resume |
| Codex | `openai/gpt-5.6-sol` | Responses stream, tools, cancel, resume |

## Security and route auth matrix

| Route/boundary | Auth | Body/input bound | Public |
|---|---|---:|---|
| `GET /api/ai/provider-settings/v3` | existing owner session | n/a | No |
| `POST /api/ai/provider-settings/workflows/v2/keys` | existing owner session + origin policy | 8 KiB + strict Zod | No |
| OpenRouter key verification | canonical server credential only | no response body consumed; bounded headers/status | No |
| Harness child launch | gateway-supervised owner execution | exact schema and environment allowlist | No |

The browser never chooses owner identity or supplies launch environment. Fixed
provider endpoints avoid user-controlled SSRF. Every start/resume revalidates
server-owned binding and generation.

## Acceptance criteria

1. Contract tests prove stable IDs, one-account binding, curated exact models,
   unavailable-model behavior, and no fallback.
2. Credential tests cover invalid keys, timeouts, redirects, malformed replies,
   permissions, symlinks, atomic rotation, rollback, and revocation.
3. Every harness passes text, streaming, tools, cancellation, restart/resume,
   model removal, rotation, disconnect, and concurrent-generation tests.
4. UI tests prove connect once/reuse four times, draft preservation,
   unavailable models, reassignment, safe errors, and disconnect guards.
5. Paid qualification requires explicit approval and a test key; evidence records
   provider activity and exact model only, never prompts or private content.
6. Web Desktop, Electron, and Web Mobile each have independent live captures
   attached to the PR and Slack `#tech`, with commit/build and fixture limits.
7. CI is green, Greptile is 5/5, and AI/kernel, coding-agent, and product owners
   are asked to review before merge.

## Delivery

One shared ticket and stack: (1) spec/spikes, (2) canonical connection,
(3) Matrix paths, (4) coding agents, (5) qualification/rollout. Public customer
documentation ships as a separate `FinnaAI/matrix-os-site` PR.

