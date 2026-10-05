# Matrix-paid native Live policy

The owner has selected platform funding. Matrix pays Gemini Live inference. Live admission never debits user promotional or add-on credit and never requires an owner provider credential. Kernel tasks retain their existing selected Chat access source.

The platform owns the provider credential, eligibility, model, prices, and durable admission. `native_live_sessions` is an internal platform-expense record, not a user wallet. One session is admitted per owner across machines, under a deployment-wide advisory transaction lock. Initial configurable limits are a $2 conservative session reserve, $20 per owner per UTC month, 20 deployment-wide sessions, 30 minutes per session, and a bounded explicit handle allowlist for rollout. Closing without qualified final billing keeps the full reserve in the cap. All overruns remain Matrix expenses. No invoice-exact cost is inferred from audio duration or unqualified usage-event aggregation. Expiry ends media; the active reservation is released only after accepted accounting drains. Process-crashed reservations block further admission until operator reconciliation; safe automatic recovery is tracked in [#2183](https://github.com/HamedMP/matrix-os/issues/2183).

Gemini bills repeated context each turn. Platform setup pins `gemini-3.8-live`, Aoede, `NON_BLOCKING` custom tools, 1,024 output tokens, an 8,192-token compression trigger and a 4,096-token retained window. Paid built-in tools and alternate models are rejected. Provider-reported usage events are recorded using conservative audio-rate upper bounds, including thinking; duplicated or cumulative reports can over-count the cap, never charge a user. The cost cap stops the socket when reached; a single already-running response can overrun it and remains Matrix-paid.

| Boundary | Authority | Public |
|---|---|---|
| `GET /internal/containers/:handle/native-live/capabilities?runtimeSlot=...` | Machine/runtime/epoch-bound platform speech credential, current activation and billing entitlement, explicit rollout policy | No |
| `WS /internal/containers/:handle/native-live?runtimeSlot=...` | Same authority, fresh transactional platform reserve before provider connect | No |
| Gateway capabilities and session start | Existing user principal and Chat permission plus fresh platform eligibility; exact owner match | No |

No raw audio, text, transcript, provider response, or credentials are persisted in the platform accounting table. The gateway preserves canonical Chat ownership, finality and task admission. Host auth stays in production mode. First deploy enables only the isolated test handle; broader rollout remains explicit. Preview identity is revalidated through the platform machine record, never inferred from a hostname.

Google API processing is explicitly selected for this Live test; this does not establish regional processing guarantees. Regional-restriction policies cannot be declared satisfied by an API key or hostname. Real speech finality and interrupted heard-word alignment remain qualification issue #2174.

Composition entrypoints receive only calls to the extracted native-live module; its policy, admission, socket lifecycle and HTTP routes remain in focused files below 500 lines. Platform shutdown drains Live sockets and accounting before destroying the shared database. Tests cover eligibility, slot caps, expiry, budget conservation, sanitized setup, and actual bidirectional sockets. Update the public Aoede documentation in FinnaAI/matrix-os-site.

The additive expense ledger uses an independent `native-live` migration scope and source fingerprint. A newer deployed core revision is preserved and does not suppress the Live ledger installation. The shared migration runner keeps the same advisory transaction lock across scopes, so concurrent startup cannot race DDL.
