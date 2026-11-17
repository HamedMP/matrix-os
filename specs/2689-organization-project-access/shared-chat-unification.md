# Shared project Chat repair

Part of [ENG-29](https://linear.app/matrix-os/issue/ENG-29).

## Outcome

Every current organization member can open an existing shared project Chat,
send a prompt immediately and receive the configured agent's reply. Owners and
peers use the same shared Chat view, with attribution on every human prompt.
There is no owner approval step for sending a prompt. Concurrent prompts retain
durable ordering, displayed as ordinary Chat activity rather than an approval
queue. Shared/private views reuse the existing composer and message primitives.

## Verified faults

- Live Codex and Claude rows have `collaboration: null`. Owner list/detail reads
  only project the old internal binding, leaving owners on the private renderer.
- Project request-list reads resolve Provider Settings/native catalogs and can
  exceed the production relay deadline. Opening a view is coupled to discovery.
- Shared composer starts disabled, and transient status failures become a hard
  AI-unavailable state. It also has a separate textarea/button implementation.
- The isolated worker's HTTP inference bridge is blocked by the sandbox's IP
  deny rule, including loopback. The previous credential-free native probe
  passes when only private-namespace localhost is allowed.
- Native Claude expands `opus` to a resolved wire model while the broker pins
  the alias; native-profile credentials also need an owner-side broker identity.
- Exact-head live Codex submission reaches the owner and starts its worker, then
  fails before inference. The Chat command socket inherits `UMask=0077`, making
  it inaccessible to the different-UID supervisor with no DAC capabilities.
  Apply the bot worker's existing socket publication contract inside the host's
  private runtime directory; retain single-use and runtime/generation checks.
- A fresh peer send can exceed the relay budget while independent owner-route
  and native catalog observations run sequentially. Observe a persisted native
  selection concurrently, and re-observe if fresh authority selects another model.
- Live Codex inference returns a complete successful Responses SSE body without
  a Content-Type header. The broker rejects it after reading the answer. Only
  for the pinned ChatGPT endpoint, validate bounded SSE frames and a terminal
  Responses event before supplying the canonical internal SSE header. Explicit
  wrong types, plain JSON/HTML, malformed or incomplete streams remain denied.

## Implementation boundaries

1. Derive the owner projection from the live inherited scope and matching owner,
   project, lifecycle and runtime. No migration or fabricated recipient rows.
2. Make project read-only capability local to current authorized membership and
   persisted selection. Provider qualification belongs to submit/dispatch, not
   opening or polling. Never cache an authorization decision across requests.
3. Permit typing immediately for a writable shared project. A failed status
   refresh cannot clear the draft or disable otherwise allowed submission.
   Explicit membership denial remains read-only; POST still reauthorizes.
4. Use the existing ChatPromptInput and shared message presentation primitives.
   Extract the existing private Conversation scroller into the UI package so
   both views share width, scroll following, history anchoring and row layout.
   Show the configured agent/model without another provider discovery request.
   Display ordinary pending/running/retry status, without owner-approval wording.
5. Repair isolated transport with localhost-only IP allowance **inside**
   PrivateNetwork. Keep IPAddressDeny=any, credential path isolation and broker
   action/model/actor fences. `network:none` remains completely offline.
6. Resolve Claude wire model from fresh trusted native inventory, separately
   from the saved selectable alias. Never accept a peer-supplied wire override
   or introduce a fallback model. Native credentials remain in the owner broker.

Large composition files receive extraction before new behavior. No direct
production patches, credential mounts, blanket networking or timeout increases.

## Authorization and failure behavior

| Boundary | Authority | Failure |
| --- | --- | --- |
| Owner list/detail | authenticated owner plus live matching inherited scope | no shared projection after unshare/mismatched owner/project |
| Shared read/status | existing signed collaboration session and current org membership | deny access; no expensive provider probe |
| Submit/retry | current membership, revision, configured owner source and exact selection | preserve draft/request; generic safe error |
| Dispatch/inference | original actor, current audience/route, scoped runtime and exact model | stop or interrupt with retry recovery |

Existing mutating route schemas/body limits and bounded queue remain. A status
read does not grant execution, credentials or access outside the project.

## Regression and acceptance checks

Tests first at the real repository, execution-adapter and React component seams.
Keep provider/native/host fixture boundaries explicit. Full live qualification
must use the exact reviewed candidate, real owner/peer sessions and real native
Codex/Claude providers in the two existing Chats.

| Actor/start | Action | Expected | Recovery/evidence |
| --- | --- | --- | --- |
| owner, project Chat with null legacy binding | open from project rail | shared view and human attribution | reopen after sharing/unsharing |
| peer, provider discovery slow/offline | open/reopen Chat | history and editable composer without discovery gate | refresh failure retains draft |
| owner and peer | send in existing Codex and Claude Chats | correct agent, reply attributed and durable | reload both; no owner approval |
| concurrent members | send while another run works | automatic ordered execution | cancel/retry, no duplicate messages |
| removed member/source disabled | submit/dispatch | safe denial despite editable prior view | no new provider call |

Affected surfaces: Electron Desktop, Web Canvas, Web Desktop and Web Mobile use
the shared UI package and require separate screenshots plus a short recording
on the current reviewed candidate. Native Mobile does not import this React DOM
panel; architectural N/A rationale needs reviewer acknowledgement. Do not claim
one surface proves another. Capture equivalent owner/peer states and reopening.
Keep all captures outside Git, attach to PR/ENG-29 and share the same evidence
in #tech with a permalink back to the PR.

Documentation deliverable: a separate `FinnaAI/matrix-os-site` documentation PR
under `content/docs/` explaining immediate shared Chat submission and automatic
run ordering, linked to ENG-29. Human collaboration/provider review recommended.
No merge is authorized.

### Exact Claude harness compatibility

Live validation on bundle 2060 established that the owner's current `opus` alias resolves to `claude-opus-5-5`. Anthropic rejects the isolated 2.1.240 harness with HTTP 400 and explicitly requires at least 2.1.280; the owner CLI is 2.1.301. Pin Agent SDK 0.3.301 and its bundled native 2.1.301 harness together, regenerate the profile digest, and assert the installed binary's actual version against the supervisor pin. The registry published 0.3.301 on 2026-10-15, preserving the seven-day package delay. Do not substitute another model or provider. Both SDK consumers use the same pin so the root host-bundle SDK/native pair is unambiguous.

This is a dependent native stack layer under ENG-29; source review and full CI apply to both layers. Existing shared Codex and Claude replies must be reverified on the combined exact bundle before completion.
