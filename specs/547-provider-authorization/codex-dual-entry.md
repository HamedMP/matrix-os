# Independent native Codex and Matrix AI subscriptions

Status: ENG-268 implementation prepared for review. Real native OAuth and runtime acceptance are not performed by fixture validation.

## Outcome and ownership

Restore the owner-initiated native Codex subscription entry under Coding agents alongside Matrix AI. Each entry owns its account, credentials, permission state, execution source and revocation lifecycle. Native Codex cannot reuse a Matrix AI token, peer grant or account-selection receipt. Matrix AI disconnect must not log out Codex; native logout must not revoke Matrix AI.

Preserve legacy native profile IDs and owner intent. Native subscription calls fail closed on changed owner, account, Computer, credential generation, expiry, revocation or uncertain recovery. No automatic API-key or Matrix-credit fallback and no whole revert of #2198.

## Native CLI and embedded authentication

[Official Codex authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices) documents owner-operated remote/headless `codex login --device-auth`. The native entry opens this official CLI flow in the selected Computer's Terminal; Codex owns its credential lifecycle. Matrix AI's SIWC registration is not a universal prerequisite for this native CLI flow.

[App-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints) separately describes local/open-source application authentication and excludes commercial/hosted service authentication from that path. Do not restore the removed embedded app-server browser/device-code login, reuse Matrix AI tokens, or present Terminal as a way to evade an excluded integration. This change does not establish vendor qualification for every service composition. Any separately proposed hosted OAuth integration must follow its actual supported provider contract.

[SIWC plan usage](https://learn.chatgpt.com/siwc/token-sharing-open-source) and the [owner self-hosted VM guide](https://learn.chatgpt.com/siwc/token-sharing-open-source/self-hosted-vms) describe separate integrations; neither is a requirement to replace every native CLI account. Do not infer a policy change date from #2198 or require the user to supply a registration merely because it was not found in the repository.

## Foreground login contract

1. Require the current authenticated writable Computer owner and an installed exact native Codex harness. Use its runtime-owned HOME and profile writer fencing.
2. Publish terminal-only Codex login and the explicit `openai_terminal` native subscription option. Backend, V1/V2 capability, direct coordinator and shared UI agree. Embedded browser/device-code and stale injected options stay unavailable.
3. Preserve existing credentials. Native CLI login can clear prior credentials before consent; an already connected profile must not be silently replaced. Reuse only an independently verified exact native subscription account; changing accounts requires the explicit native sign-out lifecycle. Ambiguous status never authorizes a new login or completion.
4. A successful process exit or generic authenticated flag is insufficient. Require fresh privately bound native principal, current source/account/model and owner identity.
5. Complete the exact fixed-native selection through a private serialized store operation and the production coordinator. Check revision, recheck identity before persistence and compensate admitted runtime changes on failure. Never enable whichever key/funded source was previously selected.
6. Bind foreground completion to the revision returned by the login-start receipt; any intervening settings write requires an explicit retry. Neither in-flight completion nor replay can undo later owner Off or another saved selection. Generic public mutations cannot manufacture private native completion proof.

## Invocation, continuation and revocation

Native source intent determines child credentials and provider selection. Validate current exact owner/Computer/account/source and credential generation before launch, turn and steering/continuation. Do not let an existing process continue under another identity merely because the saved harness is enabled. Retain existing session history on blocked continuation. Persist the nonsecret native generation and consent revision; reacquire the current private account proof after restart. Legacy accounts remain visible, but need explicit Terminal reconfirmation before execution. Unrelated provider settings changes do not revoke native Codex consent. Name and accent-color edits preserve the execution fingerprint and existing session binding; model, source, account and consent changes still fence continuation.

Explicit native source selection must suppress inherited API keys, proxy/funded configuration and alternate-provider fallback. Revoke/removal checks current private native identity again under its admitted writer lease, clears only that native credential, invalidates its observations and fences active/future native execution. Matrix AI account/grant and independently stored keys remain separate. Preserve conservative behavior for unknown cleanup and legacy account aliases. Persist a bounded native session index so revocation also finds sessions before lazy history loading. Final child admission must recheck saved consent and the revocation fence, including a launch delayed until after revocation has completed. Known pre-launch or confirmed-reaped failures may release their exact registration using process-private cleanup evidence; a generic failure, timeout or missing session after launch is not cleanup proof.

Normal expiry maintenance stops only expired sessions and does not create a global revocation marker while healthy sessions continue. Explicit revocation still drains every registered native session. Validate action support and exact removal dependencies before draining; rejected removal must leave running work untouched. Confirmed project deletion releases the exact owner/session registration before removing its files. A signed-out native account can be removed only after dependencies are cleared and an exact bounded CLI status check confirms absence under the profile writer lease; this path never runs logout against a replacement account.

Protected credential-file rotation changes the native generation, including an ordinary CLI refresh that changes those bytes. Existing runs then fail closed and require explicit reconnect/reconfirmation. Seamless refresh is not claimed by this implementation.

## Authentication matrix

| Path | Authority | Required behavior |
| --- | --- | --- |
| V1/V2 native Terminal workflow | Current writable Computer owner, installed native harness and profile lease | Official owner CLI handoff only; reject embedded or forged methods |
| Private native completion | Foreground coordinator plus fresh privately bound native identity | Exact revisioned source/account selection; no renderer proof |
| Direct Settings/Terminal login | Same owner, harness and writer authority | No alternate embedded OAuth path or implicit account replacement |
| Native launch/turn/steer | Current exact owner/Computer/source/account/generation | Identity drift and revoke deny continuation; no key/funded fallback |
| Native logout/removal | Exact current native principal under writer lease | Independent lifecycle; stale account cannot log out a replacement |
| Matrix AI invocation/revoke | Independent Matrix AI peer/account grant | Native state confers no authority and is not the revocation target |

No new public endpoint is required. Existing route authentication, body limits, bounded validation, revisions, idempotency and generic errors remain required. Any new endpoint needs a separate explicit route/auth/limit design before implementation.

## Validation and delivery

Write targeted failing tests before each change. Cover current terminal capability and actual handoff, stale embedded methods, existing account preservation, exact native completion with a saved key route, unrelated Matrix AI account, wrong owner/source/model, principal drift, revision conflict, replay after Off and coordinator compensation. Exercise real production store/facade/coordinator seams rather than a stub claiming support.

Test native launch, turn, steer, expiry/revoke and changed account generation with no key/Matrix-credit fallback. Cover independent native/Matrix AI revoke and legacy accounts. Shared UI must preserve equivalent semantics across Web Canvas, Web Desktop and Electron Desktop and applicable mobile. Claude and API-key behavior remain compatible.

Run focused regression suites, affected typechecks, lint and pattern checks; keep exact results in the PR. Real login, native commands, expand/multiline/copy, continuation, reopen and matching client/Computer Human Review remain distinct coordinated acceptance gates. Pi Chat is not a substitute. Do not close ENG-268 or claim restored live execution based on a fixture pass alone.

Ship dependency-ordered native GitHub implementation PRs under ENG-268, keeping each layer below the repository review-size limits, then a separate public documentation PR in `FinnaAI/matrix-os-site` for supported behavior. Greptile and merge follow the existing human review authorization. No real grant, credential copying, paid inference, runtime configuration or deployment is authorized by this spec.
