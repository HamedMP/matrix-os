# Matrix AI Chat and bot model routing

Status: implementation; ENG-107. Dependencies: pinned Pi runtime from PR #2048.

## Product behavior

Users select an eligible Matrix AI Gateway model in Chat and execute text and artifact
tasks through the Matrix-owned Pi worker. A recipe bot can optionally persist a concrete
Matrix AI choice at creation or through a revisioned edit. Automatic remains compatible
with existing recipes and operator Codex routing. Explicit Matrix selection never silently
falls back to Codex, the Claude kernel, an owner credential, or another model.

Web Desktop, Web Canvas, Electron Desktop and applicable mobile controls share model
selection derivation. Saved unavailable choices stay visible and require a deliberate
change or retry. Model editing must preserve omitted metadata, bot identity, and memory.

## Runtime and authority

The public `matrix_pi` driver and `matrix_pi_default` instance represent managed Chat;
the native `pi` coding CLI and private `matrix_bot` recipe runtime remain distinct.
Gateway admission validates current model/source policy and resolves the route. The
same pinned Pi worker receives either `managed_chat` or `recipe_bot` authority.
Ordinary Chat creates no bot/task records and inherits no recipe integration grants.

Managed sessions and checkpoints persist in owner-controlled Postgres, independently
of recipe bot sessions. Keys include owner and canonical Chat identity. Canonical history
feeds new turns; provider-private state never cross-resumes a different driver.
Private chat workspaces bind an owner hash and Chat ID plus inode identity; associated
project roots use existing owner-authorized resolution. Artifacts remain root-scoped.
Reading is supported; full-access writes create files exclusively. Overwriting existing
files and managed Chat image attachments are explicitly unavailable in this increment.

## Auth matrix

| Boundary | Authority | Public |
| --- | --- | --- |
| Provider/catalog reads | Existing authenticated runtime principal; owner snapshot | No |
| Chat creation/turn/steer/cancel | Existing Chat ACL, current owner model policy and run identity | No |
| Bot instantiate | Authenticated owner, recipe validation, idempotent request | No |
| Bot definition edit | Owner plus base revision enforced by update | No |
| Pi broker inference/tools | Registered handle/generation, owner/Chat, pinned route and granted capabilities | No |
| Relay readiness | Existing control credential; coarse readiness only | No |
| Relay inference | Signed runtime claim, model allowlist, atomic reservation and settlement | No |

Keep broker credentials outside workers; preserve network isolation. Reauthorize after
queue waits. Validate bounded inputs and body limits. Cap registries/event queues, bind
cancellation and execution deadlines, and drain owned resources at shutdown. Sessions
and dependent writes use transactions; shared pool ownership stays with its creator.

## Pricing and readiness

Readiness requires fresh policy, positive funding and a valid per-model receipt.
Jev evaluator success does not establish GLM or Sonnet generation readiness.
GLM/Sonnet numeric rates remain immutable versioned snapshots. Operator review binds
an exact snapshot version to strict UTC `reviewedAt` and `validThrough`, with a positive
window of at most 31 days. Missing reviews retain the historical expired snapshot;
partial, malformed, future, mismatched and expired reviews fail closed. No rolling
process-start renewal or numeric environment override is accepted.

Readiness and generation admission consume the same review. Recheck after probes and
authorization, releasing an untouched reservation if it expires before start. Existing
reservations settle using captured historical rates. Failed peers' short observation TTLs
must not invalidate a healthy model receipt; policy, funding and caller cancellation still
apply. Deployment must carry reviewed configuration without generating new timestamps.

## Delivery evidence

Record failing regressions before fixes, focused tests/typechecks/builds, and a separately
reviewed public documentation PR in `FinnaAI/matrix-os-site`. Validate an exact-head
Preview VPS with Electron Desktop: model A text/tool/resume, model B text, bot create/edit/
reopen, cancellation, safe unavailable behavior and independent route/accounting evidence.
Record client path/version/commit, immutable bundle runtimeVersion and Relay/Platform
revision. Stop at Human Review before requested Greptile and landing gates. Automated
faux-provider tests prove wiring; they do not prove deployed paid inference.

Deferred: broader Hermes migration, arbitrary provider routes, full filesystem editing,
managed attachments, fleet promotion, credit grants, and automatic pricing renewal.
