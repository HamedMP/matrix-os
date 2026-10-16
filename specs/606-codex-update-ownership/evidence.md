# ENG-298 — English local cases and evidence

This is an unpublished local candidate on Maine8cc2cb1e19a6b0afc0d9e30490aaced9a8d8aaf. The exact candidate commit and measured totals live in the final local receipt. It is not a customer installation or production acceptance.

## Verified source distinctions

[ENG-298](https://linear.app/matrix-os/issue/ENG-298/codex-pinned-at-01561-on-customer-vpses-npm-i-g-openaicodex-lands-in-a) and the complete [original Slack thread](https://app.slack.com/client/T0C11D9M36Z/C0C459830FJ/thread/C0C459830FJ-1791983925.023589) reported managed0.156.1 and a user npm0.162.1 duplicate on bundlev2026.10.14-1767. Handoff-to-Chat remains separate. No fleet measurement or live affected-host inspection was performed here.

Main#2657 qualifies0.163.0 exec/app-server payloads, while managed installation remains0.156.1 and the scope worker separately remains0.154.0. The candidate preserves all new protocol records and promotes installed/shared pins to0.163.0. Protocol qualification does not grant any account model entitlement.

Hermes's old installer redirects global npm to owner.local. v0.22 source e06df9c2eae6901f4c88f464e0ae6e753c0428b8 packages Node26.7.0 and npm12.0.2 separately. Actual npm globalconfig derives from the PM Node prefix, despite npm's different package path. PM verifies whole tool-tree digests on explicit installs, so adding node-entry/etc/npmrc is not durable. Independent review caught that first design; it was replaced with an external Matrix default and unchanged package trees/facts.

## Runtime map

| Consumer | Candidate behavior |
|---|---|
| Terminal Codex / generic PATH callers | Recognized old npm shim reaches managed Codex; custom commands survive |
| Tool-pack / boot reconciliation | Exact0.163.0 package, explicit runtime prefix, failed repair retries |
| Native Chat/event consumers | Same managed executable and retained protocol parsing records |
| Isolated scope worker | Exact0.163.0 gate; obsolete strict config remains removed |
| Legacy Hermes npm | Owner-local node/etc/npmrc repaired; private tools remain |
| Hermes v0.22 PM npm | External matrix-npm/npmrc selected in fresh non-root Matrix owner environments |
| Restricted Hermes profile | Environment admission unchanged; no new npm configuration authority |

## Cases and observations

| Case | Expected and observed local result |
|---|---|
| Legacy repair | Atomic prefix convergence, existing runtime npmrc unchanged, private links and unrelated options retained |
| PM repair | Active facts selected safely; external default created; no edits to Node/npm trees or PM facts |
| PM lifetime | Configuration is outside package entries; copied-real-Node/npm tree digests remain unchanged |
| Owner choice | User prefix and environment prefix override remain effective; custom user globalconfig choice respected at fresh startup; pre-existing PM/runtime global files suppress activation; explicit globalconfig env values, including empty, retained |
| PM failures | Malformed/oversized/unknown facts, traversal entries and symlinked store/config paths rejected |
| Partial install | Missing Node fact creates no new PM state; absent managed Codex preserves old shim; failed Codex repair retried |
| Root boundary | Failing-first marker test exposed owner PM execution in root startup; shell EUID and direct Node effective-UID guards now skip it. UID observations are simulated, not actual root/sudo execution |
| Promotion | Installer, contract, Docker development, scope gate and profile/acceptance constants agree at0.163.0; unknown versions stay rejected |
| Exact process | No0.163.0 CLI installed/executed in this round; the opt-in scope native process test is intentionally skipped |
| Live model/surfaces | Not tested; no sol6.1 entitlement, live GUI, Linux isolation or rollout claim |

The first PM TDD run failed16 assertions as expected. The next coherence run caught the changed scope profile digest; a broader run exposed one more stale supervisor digest assertion (390 passed,4 skipped,1 failed). That assertion was corrected and the next affected run passed398 tests with4 skips. Final affected-scope result after all corrections: **33 files (32 passed, one opt-in file skipped);400 tests passed,4 skipped,0 failed** under isolated Node24.18.0. This is an affected-scope receipt, not a full-repository test claim.

The independent local review found the digest-bound write (P2) and then root execution of owner PM tools (P1). Both received failing regressions and corrections. Local review is not a GitHub approving review. Workspace native typechecks and pattern/syntax checks were run locally; exact final results are in the local receipt. No full-repository local green is claimed from affected tests.

The real PM probe copies existing isolated tool bytes into a disposable task fixture. It performs version/config reads only, exercises the production owner-env/helper activation, asserts unchanged tool digests, and removes the copy. It does not install packages, modify ENG-306's fixture, read real owner credentials, contact providers or spend inference budget.

## Publication and acceptance gates

Published#2593 remains at historicalaadfe9b6. Its historical5/5 and CI38581647436 remain real but do not qualify this changed/rebased local candidate. Main#2666 removed automatic Claude review; this round still authorizes no push/CI/external review. Before future publication/landing, establish exact source freshness, review, real green CI, no unresolved findings and independent non-author approval last. Preserve the original checkpoint backup/bundle; do not silently force-push its rewritten history.

ENG-306 retains its sole upgrade author. It should consume the one shared reconciler and owner-env integration; no duplicate PM implementation. ENG-268 and waiting PRs2514/2545/2622/2578 were not changed. No Main machine, customer/production service, Electron, Private repo, Slack or paid/provider call was used. Public docs and live surface/account acceptance remain separately coordinated deliverables.
