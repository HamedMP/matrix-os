# Bounded owner confirmation wait

The owner requested up to 30 minutes to decide an exact routine operation. The
previous ten-second CLI transport budget included the host's human decision wait;
the host withheld the capability until that decision. This could cancel a genuine
card before the owner answered. This change adds a human wait phase, rather than
increasing the API or network timeout.

| Clock | Limit and boundary |
| --- | --- |
| Owner challenge requiring a human decision / mutation capability handoff | 30 minutes maximum, clipped to the **original** source expiration |
| Decision without a human wait (read or full access) | Existing maximum 120 seconds, including later accepted-claim validation |
| Read operation | 10 seconds, without a human wait or a fresh second HTTP budget |
| HTTP after a mutation capability arrives | Fresh 10 seconds, including response consumption |
| Fixed CLI child | 30 minutes + 10 seconds startup + 10 seconds HTTP; known reads remain bounded to 10 seconds |
| Native callback / outer transport | Fixed child limit + 10 seconds for bounded cancellation/drain |
| Authenticated managed Pi mutation | Gateway broker allows 10 seconds beyond the native callback; its host socket and worker allow another 10 seconds for the reply |
| Browser purpose proof | Existing maximum 60 seconds, freshly minted at the owner's click |
| Issued capability | Existing short one-shot lifetime, unchanged |
| Result display artifact | Existing 120-second post-result lifetime, unchanged |

These are host-owned constants, with no CLI or environment override. The native
Pi asset embeds the shared budget during host rendering. Standalone Codex,
OpenCode and Hermes assets retain their bounded local copy because they cannot
resolve the host TypeScript package from the owned native environment. Their read
and mutation branches use the same limits. This does not qualify or enable a
previously disabled adapter.

The host grants the managed Pi socket allowance after the broker verifies the current registered interactive run and its mutation capability. Read calls, stale or unregistered runs and other host routes retain their existing transport budgets.

Only `ask` challenges receive the longer lifetime. Automatically allowed/read
entries keep their existing maximum 120-second decision/accepted-claim fence.
The existing 30-minute Chat/Terminal source lease is not renewed. A call made late
in that lease expires sooner than 30 minutes. The delegated Bot-child source keeps
its existing shorter lease. Expiration never creates a replacement source or
replays a mutation. The native process, source generation, original owner, Chat,
run and invocation must remain live throughout the wait.

The existing controller revalidates source generation, current policy fingerprint,
private target and routing revision before and after remote proof verification,
at issue, and at capability consume. Mutation revision is still checked by the
canonical backend. A new proof cannot revive a dead source, stale target or
expired challenge. Revocation, source death, mode/policy change, call cancellation,
disconnect and shutdown discard pending authority; late capability delivery is
fenced. There is no database transaction held during a human or Platform wait.
Human approval events continue to pause only the run's idle clock; funded-run
ceilings, source abort and shutdown remain effective. The prepared producer's
fixed resolution publisher is retained only to resolve the original challenge
once if its registry entry expires or is revoked first. It cannot publish a new
request or issue, renew or revive authority. Terminal sources still emit no
synthetic Chat event. Publication failures remain isolated and logged.

A timeout or lost response for a mutation returns the original request UUID with
`unknown` and reconciliation required. It does not mean absence, cancellation of
backend execution, or permission to retry. An explicit owner decline remains an
explicit permission error. No HTTP request is sent before host capability delivery.
Routine activation approval, background model authorization and integration grants
remain separate from this exact-operation confirmation.

## Acceptance evidence and limits

Required regression lanes exercise the production CLI client with an isolated
clock/IPC transport, the actual packed CLI child/host IPC boundary with a real
11-second owner hold, the production native hook, and the real PostgreSQL
controller/Platform proof/one-shot consumption boundary. Missing prerequisites fail
those lanes. Synthetic HTTP responses and native fixture responses are not a real
provider, account, owner click, backend scheduling, or complete Dev acceptance.

An additional offline probe uses the exact public Claude 2.1.317 native artifact,
a fresh empty profile, an inspected network-disabled container and a local synthetic
API. It must observe a genuine callback held beyond 120 seconds, then the rewritten
harmless tool result, native completion, process exit and cleanup. A real 30-minute
hold is a separate evidence gate; initialization ACK is insufficient. Older admitted
native versions and other harnesses need matching runtime acceptance before a claim
that all native protocols have been qualified for the longer wait.

Owner browser authentication, source/run termination and native provider login
are distinct. An invalid owner browser session cannot mint a new purpose proof;
the existing proof lifetime remains at most 60 seconds. Source/run abort and
current policy/target checks still fence issuance and consumption. Real Clerk
logout has not been exercised in these isolated tests. Native Claude provider
logout currently does not explicitly abort an already admitted Chat source; its
next provider request may fail. The approved routine source spec does not require
that provider logout cancel every existing run immediately. This budget patch adds
no credential monitor, new identity source, or provider lifecycle behavior, and
makes no claim of immediate native-logout cancellation.

This work does not establish production Platform purpose-route availability. Dev
acceptance still requires a real owner proof, canonical proposal/approval, scheduled
result, revision-safe controls and history-preserving archive on matching installed
bytes. Record a demo only after that complete acceptance. Publish a separate
English documentation PR in the private `FinnaAI/matrix-os-site` repository before
shipping the feature; no discovery/skill implementation is duplicated here.
