# Preserve Browser configuration during funded update recovery

Tracking: [ENG-332](https://linear.app/matrix-os/issue/ENG-332/ship-shared-chrome-browser-and-scoped-agent-permissions).
Related incident: [ENG-367](https://linear.app/matrix-os/issue/ENG-367/fix-first-click-project-sharing-and-restore-organization-picker), parent ENG-29.

## Problem and scope

Native Browser setup writes `MATRIX_BROWSER_LAB_VIEWER_AUTH` and
`MATRIX_BROWSER_LAB` after funded configuration has sealed its complete
`host.env` image. The existing recovery verifier accepts only independent
speech-writer changes, so an otherwise valid update stops before services stop.
Repeated updates cannot repair this mismatch. This change restores protected
recovery and adds an explicit operator migration for older installed verifiers.
It reuses the backend portion of the existing ENG-332 fix; Settings UI changes
are separate work.

## Authority and invariants

- Root-owned release metadata, the installed component/unit hashes, funded
  receipt, complete rollback original, patch and identity remain authoritative.
- Accept only exact bounded replays of the existing speech and Browser writers.
  Validate canonical credentials, literal enablement and duplicate assignments;
  reject unrelated changes, shell expressions, malformed data and unknown drift.
- Preserve current Browser credentials, explicit opt-out, independent speech
  values, every unrelated byte and the original funded rollback semantics,
  including an originally absent runtime-token epoch.
- Ordinary recovery proofs remain read-only. Explicit root-only resealing needs
  fresh receipt and host-file hash/inode/device guards and no active updater or
  pending funded invocation. It holds existing maintenance, install and
  environment locks plus the Browser writer lock when credentials are present.
- A durable intent precedes atomic journal/environment/applied-record writes.
  Intermediate mismatches fail closed. Fresh guards allow validated roll-forward
  after every interruption; old interrupted speech migrations remain resumable.
- Keep the historical helper/marker names for compatibility and emit an
  identical `matrix-reseal-funded-config.py` operator alias. No new endpoint,
  authorization fallback, permission change or customer-data store is added.

## Qualification and operator sequence

1. Demonstrate failure using the real Browser writer against a sealed funded
   fixture, then pass both writer orders, Browser-only and absent-epoch cases.
2. Exercise malformed/unrelated drift, stale guards, a busy Browser lock and
   every interrupted replacement. Check original rollback and opt-out behavior.
3. Run all protected root fixtures in an isolated disposable Linux container,
   including an emitted helper against the historical installed verifier.
   Skipped root cases do not qualify the change.
4. Obtain current-head review and green CI; build an immutable, unpromoted
   exact-head artifact. Record its provenance and helper checksum privately.
5. Before an authorized per-host repair, verify target identity and installed
   provenance. Run the protected helper's read-only check with fresh guards,
   then its explicit apply with newly captured guards. Verify the installed
   historical verifier accepts the resulting sealed image before retrying the
   normal pinned update. Never clear journals or disable recovery checks.
6. Verify exact installed version/commit, core service health and unchanged
   owner configuration. Record any missing disposable-VPS or live acceptance
   separately; container qualification does not prove a running customer update.

No visual surface changes: Web Canvas, Web Desktop, Electron Desktop, Web
Mobile and Native Mobile keep their existing update UI. No screenshot or live
collaboration acceptance is claimed by these root fixtures. Runtime/platform
owner review is recommended. A separate documentation PR in the private
`FinnaAI/matrix-os-site` repository remains the public-docs deliverable alongside
the Browser rollout; keep protected operator procedures and incident details
out of that public documentation.
