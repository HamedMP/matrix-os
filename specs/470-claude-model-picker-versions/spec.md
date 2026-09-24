# Claude model versions in Chat

Issue: OM-470. Source: Hamed's September 24 Discord report.

## Problem and verified baseline

The canonical Claude Code catalog always starts with `default`, `opus`, and
`sonnet` labeled "Claude default", "Claude Opus", and "Claude Sonnet". Runtime
`supportedModels()` metadata is appended, but a runtime row with the same alias
ID is skipped. A picker can therefore show a versioned Fable ID beside opaque
moving aliases. It does not tell users what `opus` currently resolves to or
whether a pinned Opus 5.5 ID is selectable.

The upstream Claude Code model configuration documents `claude-opus-5-5` and
states that `opus` resolution varies with runtime version and provider. This is
documentation of a possible model, not proof of the installed runtime or the
owner's entitlement. Matrix's owner-scoped SDK inventory remains the selection
source of truth. The inspected development host has no `claude` executable.
The read-only Main Computer probe on September 24 found Claude Code 2.1.251
and `supportedModels()` values `default`, `opus[1m]`,
`claude-fable-5[1m]`, `sonnet`, and `haiku`; the resolved default is
`claude-opus-5[1m]`. Opus 5.5 is absent. Anthropic documents that it requires
Claude Code 2.1.280 or later. The managed optional Claude Code package is
upgraded in this PR; production rollout is outside this task.

## Scope

- Project fresh SDK inventory alias rows into labels that distinguish moving
  aliases and runtime default from pinned IDs. Show a resolved version only
  when `resolvedModel` is a validated Claude ID from that inventory.
- Label discovered explicit Claude model IDs with their family and version when
  the SDK supplies an opaque or unversioned display name. Preserve the exact
  `value` used for selection and CLI handoff, including the SDK's `[1m]`
  extended-context qualifier. The canonical model-reference schema admits
  only that bounded qualifier on Claude IDs/aliases. Preserve unfamiliar
  provider IDs and their safe SDK display names.
- On discovery failure, show honest alias/default labels without a claimed
  version. Keep the existing bounded discovery, owner context, refresh,
  selection, and unsupported-model behavior.
- Reuse the canonical catalog in Web Canvas, Web Desktop, and Electron Desktop.
  No client-specific catalog or model list.
- Pin the managed VPS Claude Code package to 2.1.280 for fresh installs. On
  optional developer-tools service restart, reinstall a selected managed CLI
  only if its version is older or unreadable. Preserve newer managed-prefix
  installs even if their state marker is missing, and verify the installed
  version before marking the install successful. Failed installs retain the
  existing retry path.

## Non-goals and constraints

- Do not add a static Opus 5.5 choice, alter credentials, infer entitlement
  from public docs, or change model pricing. Do not upgrade the separately
  pinned Agent SDK or isolated scope-runtime harness as part of this managed
  Chat CLI change.
- The owner-runtime `~/.local/bin` precedes the managed Node prefix on PATH.
  A user-installed Claude binary there can shadow the managed version. The
  live inventory and turn use the same effective PATH, so the picker reports
  that effective binary's models instead of promising Opus 5.5 after a
  managed package update.
- `supportedModels()` is catalog metadata, not an execution guarantee. Native
  errors remain authoritative for unavailable models and provider limits.
- Existing persisted alias selections remain valid. A moving alias is never
  silently replaced with a pinned ID. A pinned choice reaches `--model`
  unchanged.
- Avoid claiming a resolved version from stale cached metadata after discovery
  fails. Preserve a last-good model set only under the existing cache policy,
  but remove or clearly qualify resolved-version claims if freshness cannot be
  established.

## Runtime wiring and validation

Claude credential launch -> SDK `supportedModels()` -> bounded owner-scoped
catalog source -> canonical Chat provider catalog -> shared provider-choice
projection -> Web Canvas/Web Desktop/Electron Desktop picker -> canonical turn
selection -> Claude launcher `--model`.

No new endpoint or permission surface is introduced. The existing authenticated
canonical catalog route and turn admission rules continue to enforce owner
scope and exact selection. Catalog input stays bounded by the existing 64-row,
160-character ID, and 120-character safe-label schemas; no native error text is
displayed. The SDK inventory read retains its five-second deadline and output
byte cap.

Tests begin red for alias resolution, pinned ID labels, qualified `[1m]`
choices, absent Opus 5.5, fallback after discovery failure, and exact
`--model` handoff, then for CLI version pinning and upgrade decisions. Then run the
focused gateway and picker suites. At the exact PR head, inspect Web Canvas and
Web Desktop shared behavior and capture Electron Desktop integration evidence
against a real VPS with the actual installed Claude inventory. If the VPS does
not report Opus 5.5, record that limitation rather than manufacturing it.

The compatibility spike installs Claude Code 2.1.280 into an isolated temp
directory. It reads `supportedModels()` through the repository's pinned Agent
SDK 0.3.240 with the external CLI path and runs the canonical Chat CLI flags
and stream-json input against a local synthetic Anthropic endpoint. This checks
SDK initialization and Chat protocol without using an owner's credentials or
claiming provider entitlement. The managed CLI is installed by the existing
out-of-band optional tool service, not through the repository's pnpm lockfile.

## Acceptance

1. If active inventory reports `claude-opus-5-5`, the picker displays Claude
   Opus 5.5 as an explicit selectable ID and sends exactly that ID to Claude.
   If absent, no pinned Opus 5.5 choice appears.
2. `default`, `opus`, `sonnet`, and `haiku` explain their dynamic role and show
   current resolved versions only when supported by fresh metadata. Runtime
   `[1m]` choices display their context constraint and remain exact choices.
3. Selection, refresh, account isolation, safe fallback, and exact model
   persistence continue to work across the shared clients.
4. The exact PR head has Electron Desktop integration evidence and is submitted
   for human review. No merge or deploy in this task.
5. A managed CLI below 2.1.280 is upgraded when the selected optional-tool
   service runs; 2.1.280 or newer is retained. A failed or unverifiable install
   remains retryable and does not advertise a completed upgrade.

## Documentation deliverable

Open a separate PR in private `FinnaAI/matrix-os-site` under `content/docs/`
explaining dynamic aliases, pinned IDs, runtime/account availability, and
refresh. Link it from OM-470 and the implementation PR. If repository access or
the real integration environment is unavailable, record the precise pending
gate in OM-470; do not claim the deliverable or validation completed.
