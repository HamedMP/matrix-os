# Provider harness status in Settings

Issue: ENG-27. User report: Main Computer has native CLI sign-ins, while Electron Desktop Settings labels every harness Disabled or Check failed.

## Verified behavior

On Main `v2026.09.24-1439`, saved owner configuration has Claude and Codex enabled and Hermes, OpenClaw, OpenCode, and Pi disabled. Electron Desktop Settings labels Claude Disabled and Codex Check failed. Settings calls the Anthropic account Not Authenticated while a fresh Claude Haiku Chat completes; Chat also lists Hermes as Available. Native CLI installation, saved enablement, credential state, and runnable route are separate facts. A CLI sign-in alone must not silently enable a disabled harness or authorize an unfunded route.

## Scope

- Preserve the existing fail-closed `enabled` execution decision and expose the saved enablement flag separately in the capability-aware Settings snapshot.
- Render a configured-on harness with unavailable execution as **Check connection**, keeping its switch on and available to turn off. Show **Off in Settings · Signed in** only when authoritative readiness confirms authentication; otherwise say **Off in Settings** without implying that native CLI login was checked.
- Make the switch mutate saved enablement rather than the current execution predicate. Keep the legacy snapshot shape unchanged for older clients.
- Use the shared Settings component and contract for Web Canvas, Web Desktop, and Electron Desktop. Do not infer a native CLI login from an installed binary, or conflate Settings and Chat's different runtime sources.

## Boundaries and validation

The authenticated provider settings route remains unchanged and owner-scoped. `includeCapabilities=true` adds the optional saved flag; the legacy response strips it. No new endpoint, credential read, or funding/permission change occurs.

The Claude CLI and the kernel's Anthropic profile currently have different credential observations. This PR avoids claiming they are the same account. Reconciling their account-level status and confirming the exact Chat/Settings route identity is a remaining ENG-27 acceptance condition, not a consequence of changing the row label.

Write failing projector, route, and shared-UI tests first. Verify the configured-on but unavailable case, deliberately disabled but authenticated case, safe switch-off action, legacy response, provider suites, typecheck, and pattern scan. Before release, validate Web Canvas, Web Desktop, then Electron Desktop against one exact host bundle, with an owner-authenticated screenshot and a Chat comparison. The existing dev bundle predates this fix; local tests cannot count as live acceptance.

## Follow-up: bounded Codex local observation

The Codex CLI's `login status` exit code and local model catalog do not prove remote account identity, entitlement, or a runnable model. The owner-scoped V3 source records only a short-lived local observation when the selected executable, supported version, owner HOME, inherited CODEX_HOME, and `owner_openai_profile` all match. A recognized ChatGPT login gives `present_unverified`; an exact `Not logged in` gives `absent`; API-key mode, malformed status, a mismatched source, timeout, or expiry gives `unknown` for that profile. Raw status output, paths, and credentials stay out of the API and logs.

V3 keeps Codex account, source, and instance remote readiness `unknown` even when local status succeeds. The compatibility Chat registry retains an operationally available route for a user-initiated attempt, but its `authStatus` is `unknown`; the shared Settings and Chat labels say what the local observation established. An explicit saved-off Codex harness remains unavailable for new Chat selection. This does not establish the exact remote account used by a completed turn, and it does not resolve Claude's separate selected-source mismatch.

RED fixtures cover local status classification, exact context/source matching, expiry, producer-to-V3 projection, Settings/Chat copy, saved-off behavior, and the unchanged attemptable route. Validation requires focused tests, typecheck, pattern scan, exact-head review and CI, then Web Canvas, Web Desktop, and Electron Desktop comparison on one deployed build. A passing local suite or merged PR is not live-runtime acceptance.
