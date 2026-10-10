# Native local-auth diagnostic checkpoint

Related task: [ENG-235](https://linear.app/matrix-os/issue/ENG-235/connect-settings-soul-to-the-personal-matrix-bot).

Trusted Electron main reads `OPERATOR_DIAGNOSTIC_AUTH_ONLY=1` once. Every other value retains normal startup. Renderer receives a validated read-only startup mode before importing/mounting normal Desktop. Rejected or malformed mode must show a safe error and never fall back.

The diagnostic path initializes the real local AuthService and stores, reads actual `auth:status` and `app:get-version`, and displays local signed-in/signed-out/error and build source. It neither signs in nor proves remote credentials, Gateway, Chat or Bot readiness. Existing expiry cleanup and decrypt-to-signed-out semantics remain unchanged; initialization rejection displays a generic error independently of version. No credentials cross IPC.

Only the current main renderer/main frame at its exact packaged file URL can read diagnostic IPC. Requests and responses retain shared strict validation. The normal branch's new mode IPC also checks that sender. The diagnostic branch registers no auth mutation, runtime selection, provider, native-app or catalog operations. Manual update requests reject visibly. It does not construct Plan lifecycle, updater, embed, download/import, navigation-cache or thread-event services, nor install their normal menus/shutdown flushes. Packaged local assets only; its Chromium session blocks remote requests and all permissions. This guard is local protection, not live network/funding acceptance.

Offline acceptance covers real trusted-main wiring, existing AuthService/credential store with synthetic fixtures, two-hour fake-clock zero network/timer behavior, expiry/decryption/init rejection, sender/payload validation, isolated renderer import/mount behavior, and unchanged default normal wiring. Electron/OS APIs and one rejecting local-profile read are test boundaries. Tests do not read retained credentials.

Surface scope: Electron Desktop only. Web Desktop, Web Canvas, Web Mobile and Native Mobile do not host the native main/preload startup flag. They still require their own ordinary product acceptance; this checkpoint substitutes for none of them. Recommend native/runtime-owner review before an operator launch. No public user journey or account capability changes.

Documentation deliverable: a companion developer-reference update in the private `FinnaAI/matrix-os-site` repository must describe the default-off local checkpoint, profile backup/ownership requirements and its limits. Constitution X and its documentation workflow cover this internal mode too. That site PR remains deferred to the coordinated delivery phase; this local source window does not authorize an independent publish or CI dispatch. This spec is not a replacement for that deliverable.

Before any future real diagnostic launch: verify exclusive Electron ownership through an allowed method, cold-backup the whole selected profile, use the same macOS user's Keychain, and verify new exact package/source. Retained-profile login validity and visual capture remain unverified until that controlled launch. Current app launch, paid calls, Main deployment/config/access/funding changes and public release are deferred. One final candidate build is coordinated with the native stack owner; old ASAR cannot be reused.
