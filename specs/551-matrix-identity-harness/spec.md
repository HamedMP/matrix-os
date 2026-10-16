# Connect Settings SOUL to Matrix Bot

Status: original personal Matrix Bot SOUL and canonical-phase layers delivered in merged PR2443/PR2445; historical Main/Rick acceptance is bound to source2daf2803. The separately authorized14October2026 private Bot preferences extension is in implementation, with fresh source review/CI and live acceptance tracked independently. ENG-235.

## Goal and scope

Settings > Identity & personality edits system/soul.md. The canonical personal Matrix Bot must consume this owner-saved identity on each new/continued turn through the actual direct Bot executor. The existing ordinary managed Matrix Pi Chat wiring remains included. A Global Chat screenshot is not Bot acceptance.

The dedicated Matrix Bot recipe uses the existing recipe creation/Agents/direct Bot Chat flow. Its exact server-resolved recipe version opts into full SOUL identity. Other same-runtime-owner personal private direct recipe and Matrix-managed custom procedure Bots also read SOUL, applying compatible general communication, tone and collaboration preferences while retaining their own name, role and instructions. Legacy custom Bots using saved Hermes/Codex or other harness executors bypass this Bot orchestration path and are outside this extension. No client-supplied inheritance flag, model/driver/name heuristic, auto-migration, or startup creation of an owner Bot.

Settings redesign, onboarding/hatching, general memory, full SOUL identity for noncanonical Bots, coding CLIs, company/shared/foreign Bots, production fleet rollout and live acceptance without a separately authorized test window are deferred.

## Source of truth and runtime flow

Authenticated Settings file PUT -> owner's system/soul.md -> matching configured runtime owner and verified personal private direct Bot binding -> bounded gateway reader -> fixed Bot rules/job plus full canonical identity or noncanonical general preferences -> BotRunSpec -> broker -> Pi worker.

Settings already uses /files/system/soul.md. Bot task-orchestrator previously built a prompt solely from saved agent name/instructions, recipe and confirmed memory. Ordinary managed Chat uses a separate prompt seam. Share the existing secure reader/composition between these seams; never duplicate filesystem validation or let client data choose the home/path. Pi already rebuilds system messages each turn while preserving non-system history.

## Requirements

R1. Separate SOUL read eligibility from canonical identity authority. Every recipe/Matrix-managed custom procedure Bot belonging to the configured runtime owner in a verified active personal private direct Chat is eligible for general preferences. Only the server-resolved canonical Matrix Bot recipe's existing identity policy enables conversational identity inheritance and existing canonical isolated admission. Never assign that flag to other recipes to enable SOUL.

R2. Read current SOUL once per admitted turn before inference/publication. New and continued Bot Chats receive the next saved version without restart/history loss; active runs retain their snapshot. Only startup-configured homePath and runtimeOwnerId may supply it. Foreign, missing/unverified, org/company/shared contexts receive no personal SOUL.

R3. For the canonical Matrix Bot, SOUL can set conversational name, tone and behavior, taking precedence over its default conversational name; saved display label remains separate. Other eligible recipe/custom Bots preserve their own saved name, role and authoritative instructions, and apply only compatible general preferences. Prompt boundaries explicitly reject name/role/job replacement before and after raw owner text; arbitrary SOUL Markdown is not heuristically parsed or rewritten. SOUL does not change fixed authority, tools, capabilities, approved integration scope, memory admission or human approvals. Do not mount the owner's whole home in workers.

R4. Reuse asynchronous secure reads: at most16KiB, regular-file/O_NOFOLLOW/inode checks and pinned Linux parent; combined prompt including admitted memory stays under7000tokens. Missing/empty SOUL retains defaults. Invalid UTF8/control bytes, unsafe links, unreadable files or overflow fail safely before inference; diagnostics log categories only. Never silently truncate identity instructions. Always close opened handles.

R5. TDD proves authenticated Settings save -> recipe/custom Bot instantiation/direct binding -> orchestrator -> broker -> actual Pi worker prompt. Cover canonical full identity, noncanonical name/job precedence, authoritative custom instructions, next-turn refresh, history, active snapshots, unchanged capabilities/approvals, foreign/unconfigured/shared/organization/no-proof exclusions, unsafe input failures and refusal of noncanonical isolated admission. Existing ordinary managed Pi Chat full-identity regressions continue to pass.

R6. Exact-head Main Computer Electron acceptance must use the Agents direct Matrix Bot. Preserve existing SOUL bytes, append an authorized meaningful Rick identity consistent with its original values, and leave that addition saved. Send a neutral self-introduction prompt without providing Rick's name, obtain a live reply, and capture Settings SOUL plus Bot reply together in a real app screenshot. Record immutable runtime version, Electron SHA/profile and actual Bot binding. Keep the verified exact-head Main Computer Bot environment available for Human Review; record the pre-QA backend for rollback, which must retain Rick SOUL. Preview and other affected surface evidence remains separately classified.

## Auth matrix

| Boundary | Authority | Public |
| --- | --- | --- |
| Existing Settings file read/write | Existing authentication and owner home confinement | No |
| Recipe catalog/instantiate/direct Bot Chat | Existing authenticated owner-scoped routes and server recipe resolution | No |
| SOUL read | Server-configured home, matching runtime owner and verified active personal/nonshared/direct binding | No |
| Pi run specification/tools | Existing generation-bound broker, capability/approval enforcement | No |

No new endpoint, DB table, credentials, environment key, worker mount, file copy/cache/watcher or session migration.

## Error and budget contract

| Condition | Outcome |
| --- | --- |
| Missing/blank profile or ineligible runtime owner | Existing Bot defaults; no identity/preference section |
| Eligible canonical regular bounded UTF8 profile | Compose current full personality snapshot |
| Eligible noncanonical regular bounded UTF8 profile | Compose current compatible general preferences; retain Bot name/job/instructions |
| Symlink/nonregular/inode mismatch | unsafe_file; no inference |
| Invalid UTF8/control bytes | invalid_text; no inference |
| Byte or combined token overflow | too_large; no truncation/inference |
| Other read/close error | unreadable; generic client failure |

Memory may be admitted only within the remaining combined budget. Personality cannot weaken fixed security or expand capability manifests. Linux pins /proc/self/fd parent; non-Linux path/inode fallback cannot fully exclude hostile rename/restore races and must not be described as equivalent production protection.

## Executable signatures and contracts

- Canonical recipe reference: `{ recipeId: "matrix-bot", version: "2026-10-10.1" }`; server-only `BotRecipe.identitySource?: "owner_soul"`. Old recipes omit the policy. Client-created definitions cannot write recipeRef.
- `OwnerPersonalityConfig` supplies `{ homePath: string; runtimeOwnerId: string | null | undefined }` from startup. `readOwnerSoul(homePath): Promise<string>` reads only fixed `system/soul.md`; `ownerPersonalitySection(soul): string` preserves authority/job precedence and conversational-name precedence.
- `createBotTaskOrchestrator({ personality, admission, ... })` invokes `admission.ownsDirectChat({ ownerId, botId, chatId })` before profile read, and existing `admit` revalidates before runtime publication. The binding must be active, direct, personal, owner-matched and noncollaborative.
- `buildBotSystemPrompt({ botName, instructions, recipe, now, memory?, ownerSoul? })` appends the protected owner SOUL snapshot for eligible turns. Recipe `identitySource` selects full canonical identity versus `ownerPreferencesSection(soul, botName)`; base+profile must fit before lower-priority confirmed memory is trimmed. `BotRunSpec.systemPrompt` remains the existing transport contract.
- Ordinary `createManagedPiSystemPrompt` keeps custom/drive/shared/foreign exclusions and delegates to the same reader/formatter. Existing error/limit exports remain aliases for compatibility.

## Good, base and bad cases

Good: Matrix Bot uses Rick's full conversational identity, while the owner's private Writing Bot receives compatible language/tone preferences and retains its own name and writing job. Base: missing/empty SOUL keeps each Bot's defaults. Bad: renaming another recipe to Rick or Matrix Bot must not enable canonical identity or isolated execution; foreign, shared, organization and unverified contexts cannot read personal SOUL. Unsafe profile bytes fail before inference for every eligible Bot.

## Tests required and common mistake

`tests/gateway/bots/matrix-bot-personality.test.ts` exercises recipe listing/instantiation, authenticated Settings save, real direct Bot orchestration, broker and Pi worker prompt, updates/snapshots/history, verified owner/private binding, invalid input and unchanged capabilities. Existing managed Pi personality suites cover secure reader fault injection; private-admission tests assert active noncollaborative SQL authority; system-prompt tests assert combined profile/memory budget; UI handoff tests include the canonical launch ID.

Wrong: decide SOUL access from a Bot's name, the shared executor, or assigning canonical identity policy to every recipe. Correct: verify configured runtime owner and private personal direct binding for reads, then use immutable server recipe identity policy only to choose full identity versus general preferences and preserve canonical isolated authority.

## Private Bot preferences surface and acceptance scope

This extension changes the shared gateway prompt path, not renderer UI or file permissions. All clients submit the same owner-scoped direct Bot turns; no client derives SOUL eligibility. The original exact2daf canonical screenshot remains historical and does not validate this extension.

| Surface | UI | Behavior / state | Automated tests | New live evidence |
| --- | --- | --- | --- | --- |
| Web Canvas | No UI change | Shared gateway per-turn preferences and fail-closed rules | Orchestration / broker / worker regressions | Pending separately authorized QA |
| Web Desktop | No UI change | Same shared gateway path | Same regressions | Pending separately authorized QA |
| Electron Desktop | No UI change | Same shared gateway path | Same regressions | Pending separately authorized QA |
| Web Mobile | No UI change | Same shared gateway path | Same regressions | Pending separately authorized QA |
| Native Mobile | No UI change | Same shared gateway path | Same regressions | Pending separately authorized QA |

Implementation is authorized. Affected users/stakeholders should review the preference-versus-identity distinction before live QA. The draft candidate may receive code review and formal CI; neither synthetic model fixtures nor the prior Rick screenshot prove a real model preserved another Bot's name. Coordinate any later runtime/UI/paid test with its owner before performing it.

## Verification and delivery

Run focused personality/recipe/custom/orchestration/worker tests, full typecheck, patterns, applicable formal CI and lint; distinguish known base failures from changed-code regressions. Open a new English draft implementation PR for this extension and update existing private FinnaAI/matrix-os-site docs PR221 with preference versus identity scope and next-turn behavior. Link ENG235, the spec and required PR invariants. Previously merged PR2443/PR2445 and their completion evidence remain historical deliveries, not pending implementation branches.

Prior Juniper/Cedar/Maple Main screenshots prove ordinary Matrix Pi Chat only. Private Preview inference was unavailable; no funding/credential transfer is authorized or required. Human Review readiness requires honest actual Bot evidence. Normal code review, Greptile, CI and merge preparation are authorized. The former shared-write hold is lifted; it is not a remaining approval gate. Fresh exact-head checks and applicable genuine Bot live acceptance remain required before declaring this feature accepted or ready to land. This authorization does not renew paid model, Main Computer configuration, or funding-authority changes. No Slack/team message authorization.


## Isolated readiness source composition

The candidate composes frozen SOUL `7cb84b1a3f557b776ffba99979604b92947bfc25`
with funded-readiness `de0238fa3fb62be3e609525649fb07b39436950f` in a separate
manual worktree. Preserve both per-turn owner personality and the existing
ordinary managed Pi server-issued isolated turn limits in the shared runtime.
The broker's 131072-byte bound applies to the complete serialized inference
body, including system/SOUL instructions; identity never bypasses that bound.

The optional trusted phase target is either `{ kind: "managed_chat" }` or
`{ kind: "canonical_bot", botId, recipeRef: { recipeId, version } }`. Omission
keeps the original managed Chat behavior. Unknown fields and incomplete targets
reject configuration. A canonical target never changes `isManagedPiBinding` or
widens ordinary isolated Chat's empty-history rule.

For the canonical target, validate owner, machine, runtime slot, actual runtime
credential hash and epoch, installed source and bounded phase window. Resolve
the current live canonical recipe definition from owner files, never an assumed
agent SQL table or Bot display name. Automatic chooses only the phase's fixed
managed model; conflicting explicit model/payment selections reject without
fallback. Revalidate personal active nonshared direct binding and the actual
`matrix_bot` / `matrix_bot_default` accepted/running attempt-one canonical run,
matching owner/Bot/task/chat/run and a running top-level task. Claim the real
registry binding after admission and inside guaranteed release. Carry the strict
canonical descriptor into the actual worker through the broker run specification.

A read-only claim/runtime/definition preflight blocks stale phases before any
credential resolution; it does not consume or release the durable phase.
The broker validates the complete serialized 131072-byte text-only body, fixed
model and output256, zero tools/thinking, then conditionally consumes the durable
phase immediately before its single outbound fetch. Definition, runtime and
DB binding checks repeat at consume. Consumption is never refunded on error,
capacity, abort, uncertain send, restart or rebind. Worker steering, continuation,
retry, queued extra generation and summary/compaction are disabled for the phase.
A canonical second phase on the same Bot uses genuine stored first-turn history,
without truncation or dropping turns; invalidated summaries fail before inference.
Ordinary isolated managed Chat still refuses nonempty history.

A trusted internal `canonical_matrix` observation scope fences the actual UI
catalog, provider and Settings snapshots. It keeps the safe catalog projection
while omitting unrelated native, API-key and subscription account observations.
Existing API/subscription catalog IDs retain safe unavailable descriptors with
empty models/options, produced by the same pure projection helpers as ordinary
account routes; no account readiness is fabricated.
Gateway validates actual runtime/source/window and sends runtime-authenticated
phase/digest headers. Platform independently validates the exact configured
runtime, epoch, credential, phase and config digest before cache-only readiness.
Jev or mismatched private hints fail closed. Other Platform runtimes without phase
headers retain ordinary behavior. Missing, stale or mismatched fixed-model cache
entries remain unavailable and never warm/probe a paid model. No renderer query
parameter enables this scope.

The same exact trusted canonical phase must use a read-only funding summary that
projects policy, funding and Chat availability without promotional grant,
balance handoff, monthly reconciliation or credential issuance. Ordinary summary
and reservation behavior stays unchanged. Enabled-promotion and actual DB state
regressions must prove this full catalog path before freeze. Do not change global
promotion/permission flags to facilitate a test. Expired phase configuration fails
closed; deployment owners restore the recorded original phase values afterwards.

Local acceptance exercises authenticated SOUL save, real Bot creation/admission,
registry/claim, broker, Unix bridge, installed worker SDK and actual PostgreSQL,
including two stored-history phases, concurrent consume, stale target/runtime and
unknown send failures. Scripted offline SSE is explicitly fixture evidence, never
Main Computer Bot reply acceptance. Contracts, Gateway, Platform and worker
changes require fresh component input analysis and artifacts; an old Electron
ASAR must not be relabelled as the new source.

Source checks and independent review are prerequisites to any later deployment.
This candidate performs no Main update, catalog GET, policy/funding write,
new VPS allocation or Electron launch. Preserve current Main SOUL, Bot and owner
data. The original exact runtime remains the rollback baseline until a reviewed
replacement is selected. Real reply screenshots remain a separate acceptance gate.


## SOUL save byte admission

The reader, atomic writer and Settings editor share the 16 KiB UTF-8 byte limit.
Reject overflow before opening or staging a file; return safe HTTP413 and leave
an existing valid profile inode and bytes intact. Other file writes retain their
existing body limit. Settings explains the limit, disables overflow saves, and
keeps the draft with a safe retry error when a save fails. ASCII and multibyte
boundary tests must prove saved profiles remain readable, including direct
writer callers, and that shortened drafts can be saved successfully.

The reader, atomic writer and both Settings editors share the same rejection
predicate for C0 controls and DEL, allowing tab, LF and CR. Invalid text is
rejected before any writer filesystem access or staging; the File API returns
a coarse HTTP400 and preserves the last valid SOUL bytes and inode. Editors
retain the invalid draft, explain how to correct it, and allow a corrected save.
Other generic file writes keep their existing text semantics.

## Atomic Settings SOUL publication

The existing authenticated/fenced `PUT /files/system/soul.md` producer publishes
one complete version through the shared exclusive-temp/rename helper. It never
truncates the current SOUL inode. Other generic file writes keep their existing
semantics. Concurrent reads can use the prior complete inode or the newly
published complete inode; invalid path/identity races fail before inference.

The producer validates the canonical owner directory and regular nonlinked
SOUL and checks existing write permission without truncation.
If another completed save changes the target between lstat and open, the producer
rechecks only a regular-file inode mismatch, up to eight total snapshot attempts.
It retains dev/ino equality, no-follow and nonblocking write-open checks. Permission,
symlink, nonregular and I/O failures do not retry; continuous replacement fails
closed after the bounded attempts, with owned staging cleanup.

It preserves uid/gid
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


## Catalog refresh composition regression

Ordinary refresh observes the base Provider catalog exactly once and applies the existing Anthropic and ChatGPT account projections to that same result. It must not discard a successful refreshed receipt for a second funded read. Keep this result scoped to the single refresh call; it is not cached admission authority. `tests/gateway/phase-catalog-composition.test.ts` exercises the actual account decorators, unavailable second observations, separate refresh calls, failures, read options and unchanged canonical routing.

## Disposable PostgreSQL fixture cleanup

The canonical fixture closes its owned admin pool when schema creation, platform
startup or schema teardown fails. Cleanup runs in finally; a simultaneous setup
and cleanup failure retains both errors. The dedicated PostgreSQL CI step keeps
all seven Bot/funding suites and also executes real permission-denied CREATE
SCHEMA and DROP SCHEMA cleanup regressions. Tests use only a disposable loopback
test database; temporary roles/triggers and pools are cleaned without owner data.

## Native Mobile launch recipe mirror

The Native Mobile `LAUNCH_RECIPE_IDS` mirrors the shared Web
`LAUNCH_BOT_RECIPE_IDS`, including `matrix-bot` as its first entry. This keeps the
canonical server-backed recipe in the existing computer-template flow and out of
the inspiration flow; recipe versions and identity authority remain server-owned.
The unchanged `tests/ui/agent-gallery-mobile-parity.test.ts` equality assertion
checks the complete ordered launch set across both surfaces. This mirror repair
does not change SOUL admission, capabilities, approvals or recipe behavior.
