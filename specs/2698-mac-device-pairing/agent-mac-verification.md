# Agent-driven Mac Verification

ENG-495. Continuation of the existing device pairing and verification stack; no new orchestration service.

## 1. User trigger and scope

Pair the Mac once with the selected Matrix Computer. In its private worktree Chat, select **Mac Verification** under `/mac-verification` or `@`, describe a change, and send. Selecting the Skill alone supplies a task to inspect and verify the current worktree, including supported uncommitted edits. The user does not select a Mac source directory, copy a worktree ID or run a verification script.

The shipped Skill supplies the agent's preparation/test instructions. The native continuation requests verification for that exact admitted run after it completes. A normal message without a selected verification intent does not silently authorize local execution. Loading prose alone is not a model execution tool. The same-Computer agent may queue `matrix mac verify --current --recipe <supported-recipe>` as its final action. The CLI derives a unique active owner Chat from the real Git root and authenticated worktree/Chat inventories, rechecks its admission immediately before writing a bounded intent, and refuses ambiguity or a stale/racing context. The Mac consumes only that exact completed run. The selected native Skill continuation does not also queue this intent. This CLI route and the UI route have separate live acceptance gates.

## 2. Signatures and data flow

`Skill + user task -> canonical private Chat admission with existing worktree root -> exact completed run -> authenticated source manifest -> paired native controller -> offline support source -> tests/build/GUI -> automatic receipt in originating Chat`.

The executable support manifest has version 1, exact Git `baseSha`, `platform: darwin`, architecture, exact Node 24 version, pnpm 10.33.4, lockfile SHA-256 and fixed relative paths for `source`, Node, pnpm, standalone Electron and the offline dependency store. The signed application supplies this kit under `Resources/mac-verification-support`. Unknown versions, path escapes, invalid ownership or changed identities fail closed. The managed runtime projection is private and disposable; it never rewrites the installed application's source, original checkout or Main service tree. Tests and builds use a temporary HOME rather than the owner's settings or caches. The offline package kit omits pnpm build-checkout registration links; only package content/index data is reused.

## 3. Authorization and lifecycle contract

| Boundary | Existing authority / rule |
| --- | --- |
| Skill discovery | Signed-in native Mac client and private owner Chat; discovery does not depend on the age of the last completed run. Missing worktree/capability is explained. Shared Chats do not inherit local device access. |
| Chat admission | Existing canonical owner, Computer, project and worktree checks. The accepted run, not a guessed cwd or model-supplied path, binds verification. |
| Native IPC | Trusted main renderer; validated Chat/run target and live Full Access view binding. No new public endpoint. |
| Source read | Existing authenticated owner Gateway registry/Git/file APIs. Infer only a supported recipe from verified bytes. Recheck source and current owner before return. |
| Supervised | One local approval for the concrete action. Source preparation side effects follow approval and action pairing. |
| Full Access | Explicit paired-Mac consent plus current private Chat Full Access selection. No per-run dialog or fixed grant expiry. Source preparation follows lease acquisition; Stop, revocation, mode/Chat/Computer change or signout cancels pending work. |
| Return | Existing deduplicated canonical Chat receipt and attachment APIs. Recheck request/source/device authority. A retry cannot duplicate execution or receipts. |

## 4. Validation and errors

The initial executable recipes are sign-in and Files Trash/Undo. A single validated sign-in label edit selects sign-in; a single validated Files menu label edit selects Files. An unchanged snapshot uses the documented sign-in default. Mixed edits, arbitrary executable changes or unsupported app surfaces fail admission rather than return an unrelated screenshot. The Skill explains this boundary and preserves existing edits.

A fresh completed request remains bounded to ten minutes; this execution limit must not hide Skill discovery. An unavailable kit, incompatible Git base, missing system Git, wrong architecture or unavailable offline dependency produces a recoverable failure. Do not fall back to an arbitrary local checkout, network package install, user's shell initialization or app-as-preview executable.

## 5. Good, baseline and bad cases

- Good: user requests a supported reversible Files menu change; agent edits/tests the current isolated worktree, Mac automatically stages the exact matching source, exercises real right-click Trash and Undo on disposable data, and returns evidence to the same Chat.
- Baseline: Skill alone creates a fresh inspection/test turn, then verifies the supported unchanged source. It never executes a historical stale run directly.
- Bad: a different Chat/run/worktree, stale binding, changed candidate, wrong kit revision or unsupported multi-file delta cannot execute or borrow another user's source. Pairing does not authorize unrelated local files.

## 6. Required verification

TDD: fresh Skill-alone admission, preserved task text and loaded instructions; visible missing prerequisites; wrong/failed/queued/stale run rejection; native authorization ordering; kit revision/lockfile/path/tool checks; offline absolute-tool execution; automatic recipe selection; Stop/revoke and single receipt. Build tests must prove committed source only, no untracked secrets, pinned package manager and failure cleanup.

Real acceptance uses the existing owner's Main Chat and a separate Mac candidate/profile, without restarting or replacing Main services. Show pairing state, the actual Skill entry, a reversible Files change, tests, automatic source preparation, concrete GUI verification and automatic receipt. Capture the whole Matrix window continuously with English explanation, then restore the trial edit. Record exact candidate commit, cloud worktree version and result provenance privately. Signed builds, fixture integration, live account and clean-Mac acceptance are distinct gates. Existing system Git is an explicit prerequisite; an app-only clean Mac remains unqualified until tested.

## 7. Wrong and correct implementation

Wrong: rename the folder picker, paste a CLI result into Chat, or add a Skill Markdown file while verification still depends on a hidden completed-run-only shortcut. Do not let a directory copy rewrite Electron framework aliases to absolute build-machine paths; preserve relative symlinks, validate resource-tree confinement and strip pnpm project-registration links.

Correct: load the same shipped workflow into a fresh canonical task, retain the exact admitted run, and let the authorized native controller prepare matching source/tools and return the real result. Keep the fixed execution boundary honest; a Skill is guidance, not an authority bypass.

Public documentation is a separate `FinnaAI/matrix-os-site` PR under `content/docs/`. Document only released/qualified behavior and current prerequisites; no private Chat IDs, hostnames, account data or local paths.
