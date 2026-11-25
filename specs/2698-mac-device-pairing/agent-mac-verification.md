# Agent-driven Mac Verification

ENG-495. Continuation of the existing device pairing and verification stack; no new orchestration service.

## 1. User trigger and scope

Pair the Mac once with the selected Matrix Computer. In its private worktree Chat, select **Mac Verification** under `/mac-verification` or `@`, optionally describe a change, and send. The Skill supplies the agent’s test instructions and can start a fresh inspection of the current worktree without changing it. Native verification requires the selected continuation and the exact completed run from that submission. The flow needs no folder picker, worktree ID, manual script, pasted receipt, or separate CLI intent.

## 2. Signatures and data flow

The executable support manifest has version 3, exact Git `baseSha`, `platform: darwin`, architecture, exact Node 24 version, pnpm 10.33.4, lockfile SHA-256 and fixed relative paths for the source archive, Node, pnpm and standalone Electron. The source archive pins SHA-256, stored size, unpacked size and file count. The signed application supplies this kit under `Resources/mac-verification-support`; executable tools remain unpacked and normally signable. Dependency CAS files do not ship inside the app. Apple inspects archive contents too: the previous store archive produced 166 notarization errors, including unrelated iOS frameworks and unsigned native package binaries.

Before using the system tar extractor, the native controller copies the source archive to an exclusively created private file and verifies its full size/digest against the compiled manifest identity. It validates extracted paths, types, links and resource bounds before use. Unknown manifest versions, path escapes, invalid ownership or changed identities fail closed. The managed source projection is private and disposable; it never rewrites the installed application, original checkout or Main service tree.

After consent and pairing lease, install the pinned source’s frozen lockfile using the fixed HTTPS registry and a bounded, owned cache. Keep integrity checks, copy imports, timeouts, cancellation and cleanup of temporary checkout registration. First use requires network access and later runs can reuse verified packages. Exclude Git/tarball dependency sources, lifecycle scripts, pnpm hooks and the owner’s HOME, credentials, proxy and package-manager configuration. Only the signed exact-base kit and validated single-label snapshot authorize native source. Archive creation and extraction are bounded to 600 and 180 seconds respectively, with an 8 GiB archive and 250,000-entry tree bound.

The Mac release job has a 75-minute budget. Artifact-only dry-runs use separate concurrency per source ref and channel. Publishing and tag-triggered releases retain channel serialization without canceling running jobs. Logs expose only coarse stages and timing. Regenerate pinned Electron with the normal installer because pnpm’s side-effects cache can flatten framework aliases. Verify vendor checksum and architecture, reject flattened or escaping aliases, and preserve relative symlinks. Developer ID signing, notarization and artifact checks are mandatory.

## 3. Authorization and lifecycle contract

| Boundary | Existing authority / rule |
| --- | --- |
| Skill discovery | Signed-in native Mac client and private owner Chat; discovery does not depend on the age of the last completed run. Missing worktree/capability is explained. Shared Chats do not inherit local device access. |
| Chat admission | Verify canonical owner, Computer, project and registered worktree. Compare its authenticated Git HEAD against the pinned native manifest before sending a fresh automated task. Keep the eventual exact-run and source checks, and reconcile an unconfirmed send using its original request. |
| Native IPC | Trusted main renderer; validated Chat/run target and live Full Access view binding. No new public endpoint. |
| Source read | Existing authenticated owner Gateway registry/Git/file APIs. Infer only a supported recipe from verified bytes. Recheck source and current owner before return. |
| Supervised | One local approval for the concrete action. Source preparation side effects follow approval and action pairing. |
| Full Access | Explicit paired-Mac consent plus current private Chat Full Access selection. No per-run dialog or fixed grant expiry. Source preparation follows lease acquisition; Stop, revocation, mode/Chat/Computer change or signout cancels pending work. |
| Return | Existing deduplicated canonical Chat receipt and attachment APIs. Recheck request/source/device authority. A retry cannot duplicate execution or receipts. |

## 4. Validation and errors

The initial executable recipes are sign-in and Files Trash/Undo. A single validated sign-in label edit selects sign-in; a single validated Files menu label edit selects Files. An unchanged snapshot uses the documented sign-in default. Mixed edits, arbitrary executable changes or unsupported app surfaces fail admission rather than return an unrelated screenshot. The Skill explains this boundary and preserves existing edits.

A completed request remains eligible for ten minutes while Skill discovery has no age limit. Missing or incompatible signed support, system Git/tar, architecture or pinned dependencies produce a recoverable failure. Reject changed or out-of-scope requests. Use the signed kit, frozen dependencies, isolated environment and separate preview executable throughout.

## 5. Required verification

TDD: fresh Skill-alone admission, preserved task text and loaded instructions; visible missing prerequisites; wrong/failed/queued/stale run rejection; native authorization ordering; kit revision/lockfile/path/tool checks; private absolute-tool execution; pinned network/cache installation; automatic recipe selection; Stop/revoke and single receipt. Build tests must prove committed source only, no untracked secrets or dependency CAS payload, pinned package manager and failure cleanup. Exercise a real first install and subsequent cache reuse, frozen lock/integrity, hook/config isolation and cancellation. Removing the dependency archive must remove the actual notarization fault rather than conceal unsigned binaries. Cover a cached Electron input with flattened aliases, then verify normal installer recovery through the real copier and signer. A fixture that preserves links cannot substitute for the cache producer/consumer boundary.

Real acceptance uses the existing owner's Main Chat and a separate Mac candidate/profile, without restarting or replacing Main services. Show pairing state, the actual Skill entry, a reversible Files change, tests, automatic source preparation, concrete GUI verification and automatic receipt. Capture the whole Matrix window continuously with English explanation, then restore the trial edit. Record exact candidate commit, cloud worktree version and result provenance privately. Signed builds, fixture integration, live account and clean-Mac acceptance are distinct gates. Existing system Git and tar are explicit prerequisites; an app-only clean Mac remains unqualified until tested.

Public documentation is a separate `FinnaAI/matrix-os-site` PR under `content/docs/`. Document only released/qualified behavior and current prerequisites; no private Chat IDs, hostnames, account data or local paths.
