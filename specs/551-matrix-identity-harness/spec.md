# Connect Identity & personality to Matrix AI

Status: implemented; live acceptance pending. ENG-235.

## Goal and scope

The owner-edited Settings > Identity & personality SOUL must reach ordinary Matrix AI Chat through the Matrix-owned Pi harness. Keep the existing editor and file API. Apply edits on the next admitted turn, including an existing Chat; do not replace history or restart the gateway.

Design redesign, new profile tabs, onboarding/hatching, general memory, CLI harnesses and custom/recipe/company Bots are outside this increment. The existing legacy kernel already loads SOUL; this fixes the managed Pi seam.

## Evidence

- `desktop/src/renderer/src/features/settings/sections/IdentityPersonalitySection.tsx:8` uses `/files/system/soul.md`; saving uses the same path.
- `shell/src/components/settings/sections/IdentityPersonalitySection.tsx:55` saves through the existing file endpoint.
- `packages/kernel/src/prompt.ts:34` loads SOUL for the legacy kernel.
- `packages/gateway/src/chat/managed-pi-runtime.ts:82` supplies a fixed system prompt without owner SOUL.
- `packages/gateway/src/startup/bots.ts:360` constructs the managed runtime and already has homePath/runtimeOwnerId available.
- `packages/bot-runtime/src/loop.ts:75` drops persisted system messages and rebuilds the system prompt from each run; line 98 supplies it to the Pi Agent. Thus refresh requires no session migration.
- `specs/543-matrix-ai-pi-routing/spec.md` distinguishes ordinary managed Chat from custom/recipe Bots and fixes sandbox mount authority.

## Requirements and acceptance

R1: Read the current SOUL from the authenticated runtime owner's home after Chat admission, before the run specification is published. New and existing Chats receive the newest successfully saved content on their next turn; an already active run retains its snapshot.

R2: Use only the server-configured home and verified runtime owner, never a client-selected path, project root, agent name or metadata. A foreign owner, company/shared scope or custom Agent context cannot receive personal SOUL. Unconfigured owner identity must not expose home contents.

R3: Preserve the current Matrix tool rules, capabilities, approval enforcement and worker isolation. SOUL customizes identity/tone/behavior but grants no permissions. Do not mount the whole owner home or copy it into the worker workspace.

R4: Use bounded asynchronous reads, regular-file and symlink confinement checks, explicit ENOENT handling and deterministic prompt budgeting. Missing/empty SOUL keeps the existing Matrix prompt. Invalid, oversized or unreadable configuration returns the existing safe run failure before inference; diagnostics contain categories only, never profile text or filesystem paths. Admit at most 16 KiB of file bytes and remain below the existing 7,000-token prompt budget; do not silently slice away instructions.

R5: Integration regression proves Settings file-save to real run-spec assembly and Pi worker prompt use. It must cover fresh/continued Chat, edit while a run is active, deletion/empty file, custom/company/foreign-owner exclusion, invalid/symlinked/oversized files, permissions, and preserved transcript. Funded, ChatGPT-subscription and owner-Anthropic Matrix Pi selections share this seam.

R6: Exact-head Preview VPS plus Electron Desktop acceptance demonstrates a distinctive saved response style/name before and after an edit and after restart. Verify affected Web Desktop/Web Canvas and supported mobile Chat consumption separately when claiming surface acceptance. Restore synthetic test profile content after live validation; record evidence limitations explicitly. No production rollout in this task.

## Auth matrix

| Boundary | Authority | Public |
| --- | --- | --- |
| Existing Settings file read/write | Existing file-route authentication and owner home confinement | No |
| Chat start/continue | Existing Chat ACL, canonical personal owner and managed Pi admission | No |
| SOUL read | Gateway server home + verified runtime owner; no new endpoint | No |
| Pi run specification | Existing generation-bound broker | No |

## Technical design

Extract the fixed managed prompt into a focused helper and add a gateway-owned SOUL loader/composer. Inject its dependency at startup with homePath/runtimeOwnerId. After admission, compose the fixed Matrix rules and a clearly scoped owner-personality section; omit profile injection for custom Agent context. The broker carries the resulting string through existing BotRunSpec without schema changes. The worker already refreshes the system prompt each turn while retaining non-system history.

Use the existing conservative token estimator from bots/system-prompt.ts. Bound reads on the opened file handle; reject non-regular files and unsafe links, including a linked system directory. Fixed defaults and security guidance remain in the trusted base. A profile cannot alter capability grants or approval state.

No new database table, cache, watcher, permanent copy, scope-runtime profile or session format. Existing owner files and history remain authoritative. Reverting the prompt injection restores prior behavior without data migration.

## Executable contract

### Scope / trigger

The authenticated Settings file save crosses into gateway-managed Matrix Chat inference. Compose personality after managed admission, before publishing the run spec.

### Signatures

`createManagedPiSystemPrompt(config?: { homePath: string; runtimeOwnerId: string | null | undefined })` returns an async composer accepting `Pick<CanonicalProviderRunInput, "owner" | "context" | "sharedScopeId">` and returning `Promise<string>`. Startup passes server configuration through `createManagedPiRuntime({ personality, ... })`.

### Contracts

`BotRunSpec.systemPrompt` contains the unchanged trusted Matrix base plus bounded SOUL preferences and a final authority reminder. Missing runtime owner, foreign/personal owner mismatch, company owner, shared scope, custom Agent or drive context uses the base without reading personal files. No new endpoint or environment key is introduced. All managed model variants share this composer.

### Validation and error matrix

| Condition | Behavior |
| --- | --- |
| Missing or whitespace-only SOUL | Existing base prompt |
| Regular UTF-8 SOUL within 16 KiB and the 7,000-token combined budget | Compose once per admitted turn |
| File/system-directory link, nonregular file or inode mismatch | `unsafe_file`; fail before inference |
| Invalid UTF-8 or control bytes | `invalid_text`; fail before inference |
| Byte or token overflow | `too_large`; no truncation |
| Other read/close failure | `unreadable`; fail before inference |

Only those diagnostic categories are logged. The existing run failure remains generic to the client. All opened handles close on success/failure.

Linux production pins the system directory using `/proc/self/fd/<fd>/soul.md`, checks inode identity and opens the final component with `O_NOFOLLOW`. The non-Linux fallback checks real paths and inode identity, but cannot completely exclude a malicious parent rename/restore race between checks and open; do not claim equivalent hostile-filesystem race protection on those platforms. No native binding is added in this increment.

### Good / base / bad cases

Good: save Juniper, send a message, save Cedar while a run is active, then continue; the active run keeps Juniper and the next run receives Cedar. Base: delete or empty SOUL and continue with unchanged history. Bad: symlink SOUL outside home, exceed the byte/token limit or spoof an owner; do not infer from unsafe content or expose another owner's profile.

### Required tests

The three `managed-pi-personality*.test.ts` files verify filesystem/error boundaries, variant run specs and the authenticated Settings PUT → canonical admission → broker → actual Pi Agent chain. Assert preserved non-system history, unchanged capabilities and per-run prompt snapshots. Linux CI executes the descriptor-pinned branch. Live Preview/Electron proof separately verifies model adherence.

### Wrong / correct

Wrong: read SOUL from the client's project path or cache it when the runtime starts. Correct: `await systemPrompt(input)` after admission, using only server home and verified runtime owner. Personality text never changes capability grants or approval state.

## Delivery and deferred work

Ship tests and runtime wiring in one implementation PR linked to ENG-235. Add a separate documentation PR in private FinnaAI/matrix-os-site/content/docs explaining SOUL scope and next-turn behavior. Suggest product/design stakeholder review without messaging other people unless the user explicitly authorizes it. Stop at Yuhan Human Review; Greptile and merge follow only explicit approval. Existing onboarding and Identity/User templates remain unchanged.

Before review readiness, attach immutable build/SHA and live evidence. Missing runtime/surface access is a validation blocker, never synthetic proof. A Slack tech evidence post requires explicit messaging authorization in this chat; prepare it but do not send under the current issue/PR-only request.
