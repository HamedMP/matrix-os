# Continue older Codex Chats with verified account authority

Tracks [ENG-398](https://linear.app/matrix-os/issue/ENG-398).
Implementation and qualification: [plan.md](./plan.md).

## Goal and affected surfaces

An owner can send a new follow-up to an older native Codex Chat that retains its
conversation and workspace but predates saved account bindings. A binding ties
execution to the verified owner, computer, selected account, configuration and
consent; it is authorization metadata, not conversation history.

The shared gateway supplies this behavior to Web Canvas, Web Desktop, Electron
Desktop, Web Mobile and applicable Native Mobile. No new UI or endpoint is added.

## Intended behavior

1. For a missing binding, verify the authenticated owner and the currently
   selected native account and consent. Keep every existing nonempty binding
   strict; never silently adopt a different account or access source.
2. Reserve the existing session-start scope. Match the saved owner, project,
   session, native conversation and exact background incarnation. Prove the old
   process stopped using private runtime evidence. A live process may exit only
   through its exact-conversation idle handshake; busy or uncertain work blocks.
3. Validate the originally verified binding again before registering the session.
   Persist it through the active accepted turn's serialized publisher and require
   a positive acknowledgement before dispatch. Recheck authority at launch.
4. Cold-resume the same native conversation with only the new prompt, attachments,
   model and permissions. Preserve retained history and workspace files. A retry
   must not duplicate a previously accepted or delivered prompt.

## Security, integration and failure boundaries

| Boundary | Authority and validation |
| --- | --- |
| Existing Chat follow-up | Authenticated owner; existing provider admission and accepted-turn identity |
| Account binding | Fresh native account, configuration and consent checks; never infer authority from old saved status |
| Session and file references | Existing bounded session-ID/background-reference schemas and exact owner/project/incarnation checks before runtime access |
| Persistence and launch | Existing store mutation queue plus shared session-start reservation; manager independently verifies stopped execution |

Manager registration exposes stopped-proof capability through the orchestrator;
the workspace provider invokes focused legacy recovery before ordinary native
resume. The existing background runtime proves liveness, the existing publisher
saves the binding, and the existing workspace recovery starts the retained native
conversation. No global communication channel or new record store is introduced.
Canonical Chat/history remains in owner Postgres; compatibility metadata keeps its
existing storage contract.

Stop/idle waits are bounded to five seconds per phase and observe cancellation.
Browser authorization remains tracked through persistence and startup; revocation
prevents inference. A failed or discarded save, unknown probe, identity change or
missing dependency blocks dispatch. Existing gateway error normalization returns
safe errors; internal details remain server-side. Rejected configuration drift
must not register another binding and poison a later valid retry.

No new unbounded registry, buffer or temporary file is added. Never force-kill
uncertain work or delete scratch/history. Persisted binding after failed startup
is a recoverable state; uncertain runtime startup retains existing ownership
fences. Crash/retry paths use the same authorization and concurrency checks.

## Acceptance checks

- A missing-binding Chat persists verified authority and resumes its original
  native conversation with only the new prompt; reload and duplicate requests
  preserve history and dispatch at most once.
- Known binding mismatches, revoked authority and foreign/stale/active/unknown
  processes remain blocked without inference or history deletion.
- Save failure or discarded active-turn publication prevents dispatch. Browser
  cancellation during save also prevents dispatch.
- Configuration drift during stop proof is rejected; restoring configuration
  permits a later valid retry without waiting for registration expiry.
- Existing API-key execution, ordinary bound continuation, shared-browser
  lifecycle and transcript-retention recovery retain their existing behavior.
- Focused regression/admission/runtime tests, gateway types and required CI pass;
  public guidance is delivered in the separate site-repository documentation PR.

## Risks, release evidence and deferred scope

Deterministic tests do not establish live native-provider or surface acceptance.
Verify the same installed build on affected surfaces before release. Recommend
that the developer ask affected users or stakeholders to review and approve this
recovery contract before release; no stakeholder approval gate has been requested.

Deleted native-history reconstruction, invalid transcript repair, unsupported
legacy runtime reconstruction, customer-state repair and deployment are outside
this change. Missing exact retained identity must fail safely.
