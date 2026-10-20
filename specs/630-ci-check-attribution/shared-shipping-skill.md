# Shared engineering shipping skill

Tracking: [ENG-240](https://linear.app/matrix-os/issue/ENG-240).

Give engineers a reusable `matrix-ship` entry point for PR qualification,
preview requests, CI diagnosis and authorized shipping on Matrix infrastructure.
Keep `skills/matrix/ship` canonical, with the existing synchronizer and both
installer manifests distributing it to Matrix, Codex, Claude Code, Agent and
Hermes. Include a concise qualification reference and Codex discovery metadata.

Use current repository procedures rather than copying controller code. The
skill must distinguish exact-source tests from draft/routing-only runs, separate
merged and activated helpers, preserve existing checks and peer approval, and
respect the current engineer's scoped authorization. It must discover deployed
preview capabilities before selecting labels or promising artifacts/capacity.
It must preserve the Matrix test admission/resource boundaries and gateway.

Validation: a real sync/discovery regression copies the shipped skill and
resources into disposable homes for every supported target and loads the synced
skill through the actual kernel loader. Retain existing ownership/collision and
installer parity tests. Validate Codex skill metadata, shell syntax and relevant
skill loader tests. Update internal engineering install/usage pages.

This is internal engineer tooling, with no runtime API or product UI change;
product captures and public product documentation are not applicable. Request
engineering owner review of the reusable authorization and qualification
instructions. Publishing this skill does not deploy the unfinished unified
preview stack, provision slots, activate a controller or grant admin bypass.
