# Routine CLI confirmation and response deadlines

The owner requested up to 30 minutes to decide an exact routine operation. The
previous ten-second CLI transport budget included the host's human decision wait;
the host withheld the capability until that decision. This could cancel a genuine
card before the owner answered. Human confirmation, read responses, and mutation
acknowledgement have independent deadlines.

| Clock | Limit and boundary |
| --- | --- |
| Owner challenge requiring a human decision / mutation capability handoff | 30 minutes maximum, clipped to the **original** source expiration |
| Decision without a human wait (read or full access) | Existing maximum 120 seconds, including later accepted-claim validation |
| Read operation (`list`, `show`, `request`) | 30 seconds in the CLI child, including capability handoff and HTTP response consumption |
| HTTP after a mutation capability arrives | Fresh 10 seconds, including response consumption |
| Fixed CLI child | Mutations allow 30 minutes + 10 seconds startup + 10 seconds HTTP. Reads allow up to 40 seconds including startup and result delivery. |
| Native callback / outer transport | Fixed child limit + 10 seconds for relay, result delivery, or cancellation drain (50 seconds for reads) |
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

The Terminal socket broker, held host IPC and Gateway binding use the shared
native callback and read transport budgets. The fixed child still owns the
30-second read deadline even when an outer transport allows more time.
The socket broker extends the clock only after validating the writer's lineage.
EOF, trailing data, explicit cancellation and the original source expiry still
end the wait.

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

## Durable acknowledgement

`POST /api/routine-cli/execute` accepts the existing source-bound operation and
one-shot capability. A new mutation returns its committed receipt without waiting
for canonical proposal handoff or a worker to acknowledge cancellation. The
existing request ledger, approval, and revision checks stay in the transaction.
The Gateway tracks up to 16 post-commit operations per owner and Computer. If
full, it rejects new mutations before admission. Lookups and existing receipts
still work. Shutdown waits at most 15 seconds for tracked work and does not
start a newly committed handoff after that drain expires.
The response uses the same v1 envelope. Admission as `queued` is historical.
For a proposal, check the same UUID while the source is still live if the caller
needs to observe an approval card before reporting it. Ending the source before
the target's authorized claim can still prevent handoff.
A control receipt with disposition `applied` establishes the recorded state
change. For pause and archive, `execution.stop` remains `unconfirmed`.

| Observation | CLI behavior |
| --- | --- |
| Owner declines before HTTP | Return the explicit permission error |
| A mutation times out or loses its response | Return `unknown` with the original UUID; run `matrix routines request <uuid> --json` from a freshly authorized source |
| Fresh lookup has no receipt yet | Return `not_observed` with `mayStillArrive: true` |
| A repeated mutation has the same stored intent | Return the existing receipt without rerunning post-commit work |
| A repeated mutation changes the stored intent | Return `request_conflict` |

No HTTP request is sent before host capability delivery. Timeouts and transport
cancellation leave uncertain effects for reconciliation. They never establish
that a worker stopped or trigger a new mutation. Routine activation approval,
background model authorization, and integration grants retain their own checks.

Return after the verified transaction commit. Waiting for canonical submission
or worker cancellation before returning can turn a confirmed write into a
client-side `unknown` when those later operations are slow.

## Acceptance evidence and limits

Required regression lanes exercise the production CLI client with an isolated
clock/IPC transport, the actual packed CLI child/host IPC boundary with a real
11-second owner hold, the production native hook, and the real PostgreSQL
controller/Platform proof/one-shot consumption boundary. Missing prerequisites fail
those lanes. The packed CLI must read a streamed response that completes after
12 seconds and cancel a stalled read when the caller aborts. The Gateway
integration must return committed pause state while worker cancellation is still
blocked, then recover the same receipt through a new authorized request.

Local timing sampled capability issuance and HTTP handling through Hono with
disposable PostgreSQL 16. Twenty calls per operation gave warm medians of 9.0 ms
(list), 8.4 ms (show), and 8.4 ms (request). A real 3.7-second advisory-lock hold
produced a 3.78-second receipt lookup. The packed CLI separately reproduced the
old cutoff at 10.03 seconds. The updated client read the same delayed body in
12.55 seconds and closed a stalled response in 12 ms after caller cancellation.
The 30-second read budget leaves room for combined contention and transport
delay while bounding a stalled read. These are controlled local timings.

Synthetic HTTP responses and native fixture responses are not a real
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
