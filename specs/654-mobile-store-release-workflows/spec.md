# Mobile store beta workflows

Tickets: [ENG-552](https://linear.app/matrix-os/issue/ENG-552/automate-ios-testflight-builds-and-submissions-in-github-actions)
and [ENG-365](https://linear.app/matrix-os/issue/ENG-365/automate-android-internal-track-submissions-through-eas).

Goal: provide two manual GitHub Actions entry points for a reviewed `main`
revision: iOS build plus TestFlight upload, and Android AAB build plus Google
Play internal-testing submission. Reuse the existing Expo project, app IDs,
production build environment, remote version counter and managed credentials.

## Flow and boundaries

- Each workflow has read-only repository permissions, a platform-specific
  GitHub environment and non-cancelling concurrency. PRs, pushes and tags cannot
  release. Restrict each environment to `main`; keep EXPO_TOKEN scoped to the
  build/submit step and never execute unreviewed ref code with release secrets.
- Run mobile Jest checks, then EAS cloud build with the pinned
  CLI, production profile, frozen credentials, explicit waiting and JSON output.
- Verify one finished build for the selected platform/project/source commit.
  Submit its ID with a dedicated beta profile and wait for EAS completion.
- TestFlight upload does not request public App Review. Android's profile pins
  `track=internal` and `releaseStatus=completed` independently of production.
- Private EAS output has explicit cleanup. Summaries expose only source/build
  identity and dashboard links. A failed build cannot submit; a failed submit
  can reuse the recorded artifact after owner repair. No automatic retry,
  credential creation or public promotion is included.

## Runtime and failure handling

GitHub orchestrates both platforms on Ubuntu. Expo's macOS workers compile iOS;
no local Xcode runner or secret-file copying is required. Jobs time out after
120 minutes. Workflow concurrency serializes each platform but is not a FIFO
queue. Cancellation may leave EAS jobs running; owners inspect those jobs before
retrying. Store processing and tester access remain separate verification.

No HTTP/WS/IPC routes, persisted user data or app UI are changed. Source of truth:
`eas.json` for profiles, EAS for build IDs/version counters/credentials, GitHub
for reviewed source and environment approval. No database transaction applies.

## Validation and documentation

- Exercise the production release shell with only the external EAS CLI replaced:
  exact ID transfer for both platforms, build/submit failures, wrong project,
  platform, revision/status/ID, missing token and untrusted ref/event refusal.
- Parse actual workflow YAML and EAS JSONC to check manual/main/environment
  gates, pinned actions, frozen install and testing-only destination profiles.
- Validate shell/YAML and the pinned CLI flags. No store upload is required to
  review this infrastructure change; first live runs require owner-managed
  credentials and console confirmation, recorded in the release tickets.
- Update `docs/dev/mobile-shell.md` and the workflow README with setup,
  recovery, rotation and release-status limits. Recommend mobile/release-owner
  review of environment protection and credentials before first dispatch.
- Public docs deliverable: assess a separate `FinnaAI/matrix-os-site`
  documentation PR if beta installation instructions change. These workflows
  change internal release operations only; public installation behavior is
  unchanged, so no site edit is needed for this PR.

UI evidence is N/A because no renderer or app behavior changes; request reviewer
agreement with this architectural rationale. A first live signed beta build and
tester installation are release qualification, not claimed by mocked CLI tests.
