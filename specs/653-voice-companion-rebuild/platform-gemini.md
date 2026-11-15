# Platform Gemini credential deployment

Tracking: [ENG-476](https://linear.app/matrix-os/issue/ENG-476).

The internal Gemini Live relay requires `GEMINI_API_KEY`. A missing key rejects
the WebSocket upgrade with HTTP 503. Creating a secret alone does not configure
the relay: Cloud Run must mount it into the environment.

## Deployment contract

- Set the GitHub deployment environment variable `GEMINI_API_KEY_SECRET_BINDING`
  to `<secret-name>:<numeric-version>` after checking that the key belongs to the
  intended Google project and that Gemini billing is active.
- Empty configuration leaves Gemini unconfigured for that environment. Never
  assume production credentials should be available to preview environments.
- Deployment checks the enabled secret version and unconditional runtime access
  from direct or inherited IAM. CI reads metadata only, never credential bytes.
- Candidate, promoted, and inherited worker revisions must retain the exact
  secret-backed reference; plaintext and duplicate entries fail verification.
- The existing relay authentication and runtime selection remain unchanged.

## Verification

Regression: an environment-configured Gemini binding was absent from the actual
Cloud Run `--set-secrets` deployment path. Tests execute the deployment helper,
stub only the external gcloud boundary, and check the real workflow wiring.

Live acceptance: provider setup completes for the selected Live model, the
serving platform revision has the pinned binding, and the signed-in preview
voice call reaches ready. Provider setup alone does not prove audio or tools.

No renderer changes: review the existing voice stack's surface evidence. Product
and integration owner review is recommended. Public documentation follow-up:
describe managed voice availability in the private site repository when the
voice feature ships; keep account, payment, and key details out of public docs.
