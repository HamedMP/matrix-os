# Hermes terminal account login

ENG-306 / PR2695. Requested directly by the user on 2026-10-28.

Goal: offer ChatGPT and Claude account login in Hermes Settings through the existing owner Terminal surface. Keep copy short. Native Hermes owns OAuth; Matrix never handles authorization codes or credentials. Existing API-key options remain available.

Implementation: qualify the installed PM-selected Python and official OAuth handlers before advertising terminal methods. Launch the exact selected provider with official `hermes auth add ... --type oauth` in an owner Terminal. Use the existing durable Hermes writer fence and exact command-result observer. Only after exit zero and fresh native OAuth evidence may the selected route be activated atomically. Cancel/timeout must reap the exact incarnation before releasing the writer. Ambiguous launches retain admission until cleanup proves termination. No new endpoints or permissions.

Alternatives: API-key-only does not meet the request. Reusing Codex/Claude credentials silently would select a different authentication flow. Use Hermes-owned explicit OAuth.

- [x] Add failing gateway/UI tests for both exact terminal options, provider binding, continuation and terminal settlement.
- [x] Add a focused Hermes terminal adapter and production composition; retain existing adapters.
- [x] Qualify selected Anthropic OAuth separately from API credentials with read-only native evidence; reject ambiguous origins, stale metadata and API shadowing.
- [x] Run targeted regressions, gateway/UI type checks and Desktop build. Record exact source and test evidence.
- [ ] Publish a dependent native stack PR (parent #2695 already has 48 files); build/register a matching Host bundle and update only the authorized Preview. Verify both visible entries and user-completed OAuth in Preview/local Desktop.
- [ ] Complete native model/tool/MCP acceptance; record an English product-demo-video after passing. Requalify CI/Greptile on the final head.
- [ ] Update canonical public docs in a separate FinnaAI/matrix-os-site PR linked to ENG-306; retain no-Slack instruction.

Auth: existing owner-authenticated provider-workflow routes only; trusted server option IDs bind provider/method/harness. Foreign/stale options must fail before launching a Terminal. No raw Terminal output in provider-workflow logs. Keep Preview and production/Main separate.

Live acceptance uses user-completed OAuth on a disposable Preview and the isolated local Desktop. Production/Main updates, merging and Slack remain outside this work.

Local qualification: 56 files / 743 tests pass; all official project type-check targets pass; Desktop builds successfully. Current-source native-root resolution and both official OAuth handlers were checked on the Linux x64 Preview. Account-backed model/MCP and visual acceptance remain pending. The Terminal command is 3,538 characters, below its 4,096-character argument bound.

Live validation found and reproduced an integration defect on PR2964/6e34fa1: the login producer supplied an absolute cwd while the production Terminal consumer accepts only home-relative cwd. The corrective producer now returns the relative native checkout path; the consumer's canonical containment and absolute-path rejection remain unchanged. A regression crosses the real launch producer and Zellij adapter, RED on the old producer and GREEN on the correction. Expanded qualification:58 files /770 tests pass and all eight official type-check targets pass. The failed Preview keeps its ambiguous-launch fence; replace that disposable runtime rather than deleting the safety marker. User OAuth, real native model/MCP, local Desktop parity and video still require live qualification of the corrective bundle.


## 2026-10-29 — provider/model switch P1 correction

The exact pinned upstream login helper preserves nonempty slashless model IDs,
so passing a new default does not replace an existing GPT/Claude selection. The
new characterization fixture retains the real upstream helper and credential-
cleanup functions; only storage I/O is memory-only. Both cross-provider cases
failed against the original script and now pass. The launch script writes the
advertised model, provider and endpoint together through Hermes's own atomic
config writer, preserving other config keys and the existing active-auth-store
selection contract. Invalid/missing model inventory performs no write. No OAuth,
credential migration or network call is performed by these tests.

Provider switching, same-provider selection, endpoint credential cleanup and the
single config-write boundary are covered. The production Terminal request schema
also receives the prepared command, preventing a command-size regression; the
current Python command is3988characters within4096. Current broad regression,
new-head review/CI and fresh matching Preview remain subsequent gates.


## 2026-10-29 — external-checkout launch P1

Greptile confirmed that a trusted external checkout produced a rejected ../ cwd
and the ambiguous-launch fence then blocked later settings writes. The real
producer/Zellij consumer regression fails before this fix. Trusted external
installations now launch from owner home (the Terminal protocol's empty cwd),
while retaining the qualified absolute Python path and PYTHONPATH source. Managed
in-home roots retain their previous relative cwd. Direct traversal/absolute cwd
remains rejected by the unchanged Terminal consumer. No fence or permission rule
is relaxed; a valid launch replaces the deterministic rejected launch.


A real-Python import test additionally found that owner-home cwd can shadow
PYTHONPATH with a same-name local package. Login qualification and execution now
both set PYTHONSAFEPATH=1 (supported by the pinned Python>=3.11 contract), leaving
only the explicit qualified source path. The test fails with cwd-shadow before
this flag and passes with qualified afterward; no real provider code or credential
is loaded by that fixture. No process-global or owner configuration is changed.


## 2026-10-29 — idle Terminal viewer cancels pending login

An instrumented current-head Preview run failed about125 seconds after launch,
before the ten-minute OAuth deadline. The exact inner command changed from
running to unknown and the credential pool remained empty. The workflow acquired
a soft output viewer without heartbeats; TerminalRuntime reclaims stale viewers
after two minutes, the socket closes, and the workflow treated that closure as a
reason to terminate the pending command.

The correction removes this redundant output attachment. The existing bounded
exact-incarnation command-result observer remains authoritative; exit zero still
requires fresh native credential proof and atomic provider/model selection.
Cancellation, deadline cleanup, ambiguous-launch fencing and runtime viewer TTLs
are unchanged. A regression crosses the production workflow, Unix socket, runtime
and durable store: the original source publishes failed/unavailable after the
real stale-viewer sweep, while the corrected source completes from the exact
inner receipt. Only Zellij and provider identity completion are isolated; these
tests do not qualify live OAuth, model/MCP calls or a demonstration video.

## 2026-10-30 — native interpreter handoff loses login completion

Live Electron acceptance on Preview `pv-2964-1fd6829f` at source `86dc4a77`
saved a verified Hermes-owned ChatGPT grant and exited zero, but left Hermes's
provider at `auto` and Settings disconnected. Read-only inspection found a
self-managed Git install whose PM interpreter differs from the initially
qualified interpreter. Upstream bootstrap replaces the process with the PM
interpreter. Because our wrapper had already changed `sys.argv[0]` to `hermes`,
the pinned relaunch function ran the bare CLI launcher and discarded our
remaining verification/configuration statements.

Import bootstrap while the original `-c` identity is intact, before setting CLI
arguments. Upstream then preserves the whole continuation across its interpreter
handoff. Do not disable PM, change interpreter selection rules, copy credentials,
or weaken source/admission checks. The regression uses the exact pinned
`relaunch_command`, an actual `execv`, and isolated OAuth/configuration adapters:
both providers previously logged in and exited zero without configuration, and
now retain the configuration step. Terminal payload remains within 4096 characters.

The same acceptance exposed selection/loading marks overlapping long connection
titles. Shared cards now use separate grid columns for artwork, wrapping text,
and the mark. Real-component browser geometry checks cover three card widths and
both states; existing theme contrast checks remain required. This CSS change
requires a newly built Electron client and matching Web Preview. Previous
client captures, CI/review results and successful credential storage do not
qualify the corrected source or the complete connected model/MCP journey.
