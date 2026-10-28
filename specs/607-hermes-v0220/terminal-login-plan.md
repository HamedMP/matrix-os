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
