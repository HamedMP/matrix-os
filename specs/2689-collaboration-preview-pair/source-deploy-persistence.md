# Preserve configured preview pairs across platform deployment

Part of ENG-418. This is deployment plumbing; it does not activate preview pairs.

The full platform candidate deploy replaces environment variables and secret
bindings. A Source that an operator configured for preview pairs therefore loses
admission, reader credentials and maintenance configuration on the next ordinary
release. The private singleton worker is cloned from that service, so expiry and
cleanup would also stop.

Before replacing the production Source template, read only its current
100%-serving revision. A small helper carries the known Source pair literals and
the operator/GitHub Secret Manager references into the existing atomic Cloud Run
deployment. It neither accesses secret values nor accepts candidate build input.
Unknown pair fields, plaintext credentials, invalid CLI delimiters and ambiguous
serving traffic fail the deployment instead of silently discarding configuration.
The initial service lookup must succeed: only successful service enumeration
without the exact Source name confirms absence. API/auth/network errors stop.
An unconfigured Source still produces no extra bindings and remains default-off.

The production-role revision already inherits that template and uses update-env.
The existing private worker renderer then clones it; never enable background
workers in the public API to compensate for missing worker configuration.

Regression evidence: executing the real original gcloud deploy command with
configured pair bindings omitted MATRIX_PREVIEW_PAIR_ENABLED. The changed command
preserves both flags and both secret references. Boundary tests exercise actual
revision metadata rendering, the default-serving selector, plaintext refusal,
unconfigured default-off behavior, delimiter refusal and unknown field refusal.
A dedicated unprivileged PR/main workflow executes the required checks without
installing application dependencies or receiving deployment credentials.

No new endpoint, permission grant, data write path or user-facing surface.
Cloud Run revision creation remains the atomic environment/secret update boundary.
No secret values or screenshots enter Git. The existing public preview-pair guide
and source stacks' companion site documentation remain unchanged: this fix adds
no public command or product flow. No UI capture is claimed; reviewer approval of
the infrastructure-only surface rationale remains required before readiness.

The bootstrap still requires protected GitHub environments, the immutable reviewed
controller, approved credentials and effective IAM verification. This change does
not satisfy those gates. Do not merge or deploy as part of an unapproved activation.
