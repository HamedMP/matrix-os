# Connect Settings SOUL to Matrix Bot

Status: implemented corrected Bot scope; exact-head live acceptance pending. ENG-235; PR2438.

## Goal and scope

Settings > Identity & personality edits system/soul.md. The canonical personal Matrix Bot must consume this owner-saved identity on each new/continued turn through the actual direct Bot executor. The existing ordinary managed Matrix Pi Chat wiring remains included. A Global Chat screenshot is not Bot acceptance.

There is no pre-existing canonical Matrix Bot in the fixed recipe catalog. Add a dedicated Matrix Bot recipe using the existing recipe creation/Agents/direct Bot Chat flow. Its exact server-resolved recipe version opts into owner SOUL; other custom and task-specific Bots remain independent, even if named Matrix or Rick. No client-supplied inheritance flag, model/driver/name heuristic, auto-migration, or startup creation of an owner Bot.

Settings redesign, onboarding/hatching, general memory, arbitrary Bot inheritance, coding CLIs, company/shared Bots, production fleet rollout, and merge before Human Review are deferred.

## Source of truth and runtime flow

Authenticated Settings file PUT -> owner's system/soul.md -> configured bounded gateway reader -> canonical verified direct Bot binding -> exact server recipe resolution -> fixed Bot rules/job + owner personality -> BotRunSpec -> broker -> Pi worker.

Settings already uses /files/system/soul.md. Bot task-orchestrator previously built a prompt solely from saved agent name/instructions, recipe and confirmed memory. Ordinary managed Chat uses a separate prompt seam. Share the existing secure reader/composition between these seams; never duplicate filesystem validation or let client data choose the home/path. Pi already rebuilds system messages each turn while preserving non-system history.

## Requirements

R1. Resolve the canonical Matrix Bot recipe on the server. Only its explicit identity policy enables the profile, after verification of the direct binding and personal runtime owner. Existing recipes/custom Agents retain default-off policy.

R2. Read current SOUL once per admitted turn before inference/publication. New and continued Bot Chats receive the next saved version without restart/history loss; active runs retain their snapshot. Only startup-configured homePath and runtimeOwnerId may supply it. Foreign, missing/unverified, org/company/shared contexts receive no personal SOUL.

R3. SOUL can set conversational name, tone and behavior, taking precedence over the canonical default Matrix name. Saved Bot display label remains separate. SOUL does not change fixed authority, recipe job constraints, tools, capabilities, approved integration scope, memory admission or human approvals. Do not mount the owner's whole home in workers.

R4. Reuse asynchronous secure reads: at most16KiB, regular-file/O_NOFOLLOW/inode checks and pinned Linux parent; combined prompt including admitted memory stays under7000tokens. Missing/empty SOUL retains defaults. Invalid UTF8/control bytes, unsafe links, unreadable files or overflow fail safely before inference; diagnostics log categories only. Never silently truncate identity instructions. Always close opened handles.

R5. TDD proves authenticated Settings save -> real canonical Bot instantiation/direct binding -> orchestrator -> broker -> actual Pi worker prompt. Cover next-turn refresh, history, active snapshots, unchanged capabilities/approvals, foreign/unconfigured owners, other/custom recipes (including misleading names), and unsafe input failures. Existing ordinary Chat regressions continue to pass.

R6. Exact-head Main Computer Electron acceptance must use the Agents direct Matrix Bot. Preserve existing SOUL bytes, append an authorized meaningful Rick identity consistent with its original values, and leave that addition saved. Send a neutral self-introduction prompt without providing Rick's name, obtain a live reply, and capture Settings SOUL plus Bot reply together in a real app screenshot. Record immutable runtime version, Electron SHA/profile and actual Bot binding. Keep the verified exact-head Main Computer Bot environment available for Human Review; record the pre-QA backend for rollback, which must retain Rick SOUL. Preview and other affected surface evidence remains separately classified.

## Auth matrix

| Boundary | Authority | Public |
| --- | --- | --- |
| Existing Settings file read/write | Existing authentication and owner home confinement | No |
| Recipe catalog/instantiate/direct Bot Chat | Existing authenticated owner-scoped routes and server recipe resolution | No |
| SOUL read | Server-configured home and verified personal runtime owner | No |
| Pi run specification/tools | Existing generation-bound broker, capability/approval enforcement | No |

No new endpoint, DB table, credentials, environment key, worker mount, file copy/cache/watcher or session migration.

## Error and budget contract

| Condition | Outcome |
| --- | --- |
| Missing/blank profile or default-off recipe | Existing Bot defaults |
| Eligible regular bounded UTF8 profile | Compose current snapshot |
| Symlink/nonregular/inode mismatch | unsafe_file; no inference |
| Invalid UTF8/control bytes | invalid_text; no inference |
| Byte or combined token overflow | too_large; no truncation/inference |
| Other read/close error | unreadable; generic client failure |

Memory may be admitted only within the remaining combined budget. Personality cannot weaken fixed security or expand capability manifests. Linux pins /proc/self/fd parent; non-Linux path/inode fallback cannot fully exclude hostile rename/restore races and must not be described as equivalent production protection.

## Executable signatures and contracts

- Canonical recipe reference: `{ recipeId: "matrix-bot", version: "2026-10-10.1" }`; server-only `BotRecipe.identitySource?: "owner_soul"`. Old recipes omit the policy. Client-created definitions cannot write recipeRef.
- `OwnerPersonalityConfig` supplies `{ homePath: string; runtimeOwnerId: string | null | undefined }` from startup. `readOwnerSoul(homePath): Promise<string>` reads only fixed `system/soul.md`; `ownerPersonalitySection(soul): string` preserves authority/job precedence and conversational-name precedence.
- `createBotTaskOrchestrator({ personality, admission, ... })` invokes `admission.ownsDirectChat({ ownerId, botId, chatId })` before profile read, and existing `admit` revalidates before runtime publication. The binding must be active, direct, personal, owner-matched and noncollaborative.
- `buildBotSystemPrompt({ botName, instructions, recipe, now, memory?, ownerSoul? })` appends SOUL only for the opt-in recipe; base+profile must fit before lower-priority confirmed memory is trimmed. `BotRunSpec.systemPrompt` remains the existing transport contract.
- Ordinary `createManagedPiSystemPrompt` keeps custom/drive/shared/foreign exclusions and delegates to the same reader/formatter. Existing error/limit exports remain aliases for compatibility.

## Good, base and bad cases

Good: create Matrix Bot from its server recipe, append Rick in Settings, ask for a self-introduction without naming Rick, and continue the same Bot conversation with unchanged history. Base: missing/empty SOUL keeps Matrix Bot's saved default identity. Bad: rename Writing Bot to Rick or Matrix Bot, spoof a foreign owner, or use a collaborative Chat; these cannot consume personal SOUL. Unsafe profile bytes fail before inference.

## Tests required and common mistake

`tests/gateway/bots/matrix-bot-personality.test.ts` exercises recipe listing/instantiation, authenticated Settings save, real direct Bot orchestration, broker and Pi worker prompt, updates/snapshots/history, verified owner/private binding, invalid input and unchanged capabilities. Existing managed Pi personality suites cover secure reader fault injection; private-admission tests assert active noncollaborative SQL authority; system-prompt tests assert combined profile/memory budget; UI handoff tests include the canonical launch ID.

Wrong: decide SOUL inheritance from `agent.name === "Matrix Bot"` or the shared matrix_bot executor. Correct: resolve immutable server recipe policy and independently verify direct personal runtime ownership before reading the configured home.

## Verification and delivery

Run focused personality/recipe/orchestration/worker tests, typecheck, patterns, required full tests and lint; distinguish known base macOS failures from changed-code regressions. Update existing English implementation PR2438 and private FinnaAI/matrix-os-site docs PR221 with correct identity scope, creation entry, display-label separation and next-turn behavior. Link ENG235 and required PR invariants.

Prior Juniper/Cedar/Maple Main screenshots prove ordinary Matrix Pi Chat only. Private Preview inference was unavailable; no funding/credential transfer is authorized or required. Human Review readiness requires honest actual Bot evidence. No Greptile/merge until explicit Yuhan approval. No Slack/team message authorization.


## Isolated readiness source composition

The candidate composes frozen SOUL `7cb84b1a3f557b776ffba99979604b92947bfc25`
with funded-readiness `de0238fa3fb62be3e609525649fb07b39436950f` in a separate
manual worktree. Preserve both per-turn owner personality and the existing
ordinary managed Pi server-issued isolated turn limits in the shared runtime.
The broker's 131072-byte bound applies to the complete serialized inference
body, including system/SOUL instructions; identity never bypasses that bound.

This composition does not add isolated generation fencing to canonical recipe
Bots. Ordinary Pi claim/broker tests and Bot creation are not live Bot acceptance.
The canonical recipe's real run/broker binding needs its own proof before any
single-generation claim. No paid cache warming is allowed; missing, stale or
mismatched cached readiness remains unavailable.

Matching trusted Gateway/Platform cache-only phase configuration is default-off
and does not remove funding-summary promotional grant or balance handoff paths.
A complete catalog observation requires separate fresh evidence of no such
mutation, or a reviewed server-owned exact-target read path that omits them.
Client query parameters must not disable server financial/authorization policy.
Do not change global promotion/permission flags to facilitate a test. Expired
phase configuration fails closed; restore the recorded original phase values
through the owner of that deployment rather than leave ordinary Chat blocked.

Source checks and independent review are prerequisites to any later deployment.
This candidate performs no Main update, catalog GET, policy/funding write,
new VPS allocation or Electron launch. Preserve current Main SOUL, Bot and owner
data. The original exact runtime remains the rollback baseline until a reviewed
replacement is selected. Real reply screenshots remain a separate acceptance gate.


## Atomic Settings SOUL publication

The existing authenticated/fenced `PUT /files/system/soul.md` producer publishes
one complete version through the shared exclusive-temp/rename helper. It never
truncates the current SOUL inode. Other generic file writes keep their existing
semantics. Concurrent reads can use the prior complete inode or the newly
published complete inode; invalid path/identity races fail before inference.

The producer validates the canonical owner directory and regular nonlinked
SOUL, checks existing write permission without truncation, and preserves uid/gid
and ordinary permission bits through the retained exclusive-created staging
descriptor. Missing files use private0600; observed link/parent replacement and
write failures reject the save. Before publication the helper checks that the
staged entry is regular, nonlinked, and matches the held descriptor's dev/ino.
Cleanup only unlinks an owned matching entry; a collision or substituted entry
is not removed. Linux pins
temp creation, rename and cleanup to the opened system directory. Other hosts
revalidate the parent at commit and cleanup; if a parent has been replaced,
cleanup must not follow it into a foreign directory. A private staged file can
remain in the renamed original directory for its owner to remove in that rare
failure case; it is never published as SOUL. Non-Linux retains the documented
residual directory rename race rather than claiming descriptor pinning. On all
platforms a same-UID process with direct directory access can still race the
child-entry check and pathname rename; parent pinning does not eliminate this
race. The reader rejects unsafe identity/link changes before inference, but
this is not a guarantee that an unsuccessful save left its path unchanged.

Regression evidence must exercise actual Settings route and reader with a real
write paused after truncating/writing the staging file, plus I/O failure,
metadata preservation, repeated/concurrent saves, and outside-parent/staging-link
guards. Do not mock the reader or
weaken its assertions. Gateway producer-only corrections do not relabel an
unchanged Electron component's earlier source/package metadata.
