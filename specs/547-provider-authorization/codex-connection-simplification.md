# Codex connection actions — ENG-268 / PR #2545

Supersedes the Connection options presentation in native-codex-settings-device-login.md. Authorized by the human simplification request relayed on 2026-10-18. Initial scope was the shared Settings UI; the live compatibility follow-up below also corrects existing Host lifecycle capability and identity guards. No new authentication endpoint, credential storage or automatic migration.

| Observed state | Visible actions | Explicit transition |
| --- | --- | --- |
| No native account | Qualified code/Terminal/API-key choices | Existing normal workflow, no inferred login or funding fallback |
| Connected subscription or API key | Selected account, Change account, Log out | No extra connection methods or disable-only Disconnect |
| Historical Off / missing native consent, account still authenticated | Saved account, Reconnect, Change account, Log out | Reconnect explicitly invokes the qualified native completion workflow; it never enables on render or manufactures consent |
| Saved API key, Off | Saved account and explicit reconnect when fresh validation is supported | Existing scoped freshness/revision/route guards; no key copy or login replacement |
| Changing account | Scoped confirmation before native logout | Cancel before confirmation preserves the account. Only successful logout plus refreshed signed-out state reveals normal sign-in choices. Failed/uncertain logout does not start sign-in. Cancelling/failing subsequent sign-in remains honestly signed out; old credentials are not restored |
| Read-only, unknown account, unavailable capability, or active operation | No admitted account mutation | Existing permission, operation and scope fences remain binding |

Resolve account actions from the same selected source/account as the connection card, not every historical account ID. This removes duplicate Logout controls without deleting saved accounts or treating an alias as new execution authority. Native actions stay separate from the upper device subscription and its grants.

The independent Matrix AI ChatGPT entry, status recovery, credit refresh and Private Preview behavior remain exactly as Main. This change only restores native Codex connection and account actions.

TDD: real shared Settings view tests cover connected/no-account/saved-Off/missing-consent/API key, one scoped account action, change cancellation, logout failure, successful logout then normal sign-in, new-login failure/cancellation, read-only and scope changes. Existing native gateway lifecycle/completion tests remain the backend contract. Local synthetic DTOs and mocked provider workflows do not establish real OAuth, revocation, grant or model acceptance.

Validation uses focused UI/gateway tests, affected types and pattern checks on the final Main-based candidate. Earlier live Human Review is evidence for its recorded source, not qualification of this new candidate. The running Electron client and owner credentials are not changed during source validation.

## Credential identity

A real ProviderSettingsStore regression reproduces one cause: the native
credential changes to API-key mode while durable profile intent still says
Terminal. The public connection projects the current key, but the lifecycle
capability calculation omits logout. Exact native-profile lifecycle identity
must follow fresh, privately bound native metadata without changing saved
execution consent, route, key or the independent ChatGPT grant on a read.

API-key type alone is not credential identity. A non-file account/read response
only says apiKey and cannot detect a key-to-key replacement. It remains useful
for display but cannot authorize destructive lifecycle operations. The native
reader privately marks credential-specific proof only for an established file
backend with the bounded credential proof. Both capability projection and the
writer must require this proof; the writer must reobserve the same principal
under the existing native profile guard. Unbound/keyring/auto identity stays
fail-closed. Synthetic tests must include the production reader's non-file
case, not just distinct mock principal strings.

Native account metadata now explicitly opts into bounded API-key file proof.
Accept the official key document (optional `auth_mode: apikey`, absent/null
tokens, bounded nonempty `OPENAI_API_KEY`); retain private digest equality and
all owner/mode/nofollow/profile/generation checks. Subscription execution keeps
the helper's default ChatGPT-only parser. Effective keyring/auto/unknown storage
is still insufficient authority; no API-key class-only logout is admitted.

The regression uses actual temporary key files, the production metadata reader,
real Settings store, capability policy and native profile writer with a synthetic
CLI transport. Same-key logout removes only the synthetic native credential;
a replacement key is rejected before the logout command. The independent
Matrix AI fixture remains unchanged. Existing UI confirmations consume the
admitted action; this fix does not merely force buttons visible.

Final publication follows independent review of the exact Main-relative diff, then current-head Greptile and full CI. Live credential mutation and deployment remain separate from source tests. The companion public documentation deliverable is FinnaAI/matrix-os-site PR #237.

## Active API-key work during native sign-out

API-key execution retains its key-funded launch path and receives no native
subscription intent. Track its exact owner/session reference for cleanup with a
null subscription binding, including legacy starts and process restart. Native
Log out/Change account must await that work stopping before CLI logout and the
successful Settings receipt. Failed or uncertain stops retain the durable fence;
only manager-proved clean failures release a reference. This lifecycle bookkeeping
does not grant subscription authority or affect the independent Matrix AI grant.

Device-code completion carries cancellation through the fresh account read. Cancellation before the private completion write starts must not select or enable Codex or publish success; once that write has dispatched, cleanup waits for its actual outcome. Barrier-based workflow tests cover both sides of this boundary.
