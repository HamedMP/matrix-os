# Explicit owner API processing

ENG-355 extends the existing direct Pi broker to explicitly connected OpenAI API keys, alongside the existing Anthropic API key and reviewed Matrix-managed routes. This is transport support. It does not approve an account, provider contract, model, retention control, Google scope or processing profile.

## Source and credential authority

- Owners connect OpenAI under Settings → Agents & providers using an API key. The API billing source is separate from ChatGPT, Codex, native CLI credentials and Matrix AI funding. There is no credential import or fallback.
- One private owner-controlled `system/ai-providers/openai-key.json` holds the key and a random credential generation. Private source metadata records its enabled revision and generation. The shared durable writer guard and rollback transaction protect publication; a lost or uncertain publication withdraws qualification.
- Authenticated model discovery uses the fixed OpenAI Models endpoint, a ten-second timeout, bounded response and supported text/tool model families. Discovery is availability evidence only. It does not prove provider policy, zero retention, vendor account identity or Google-data eligibility.
- Explicit selection pins connection revision, credential generation, model and API. Completions and Responses use different fixed paths. Native/OAuth subscription profiles remain denied as substitutes.
- The registry owns the binding. Dispatch, policy waits, response release, collection admission, prepared tools and continuation boundaries recheck the live source. Revocation cancels active inference; no replacement source is selected implicitly.

## Google-data boundary

Observed transport identity contains only the actual endpoint, API, model, adapter version and key fingerprint/generation. Account references and onward recipients originate in a separately reviewed processing profile. The profile must match the exact observed transport and current consent. A successful connection or Models response never creates a profile or consent.

Google-marked requests retain the existing typed payload controls: stateless `store:false`, no remote continuation IDs, hosted provider tools, unexpected cache controls or extra configuration fields. Response release revalidates the original pinned policy authority. In-chat consent and owner/machine envelopes stay in force.

## Endpoint authorization

All endpoints are mounted under `/api/ai/matrix-connections/openai`, behind current runtime-owner authentication, bounded JSON parsing and no-store responses.

| Method and path | Authority | Effect |
| --- | --- | --- |
| GET root | Exact runtime owner | Observe source; no discovery or enablement |
| POST connect | Exact runtime owner + revision/generation CAS + idempotency | Discover, then explicitly publish a new key generation |
| POST refresh | Exact runtime owner + revision/generation CAS + idempotency | Requalify current discovery; no source substitution |
| POST disconnect | Exact runtime owner + revision/generation CAS + idempotency | Disable source and cancel consumers |

Invalid credentials, unavailable source state, stale generation, unsupported models or missing policy fail closed. Runtime responses expose safe errors; secrets and raw provider diagnostics never enter UI receipts.

## Evidence and public documentation

Focused regression suites cover canonical custody, source selection, supported wire APIs, rotation, no native/funded fallback, HTTP ownership/body bounds and the shared API connection card. Full CI and live captures must qualify the final exact commit. A real owner API key, reviewed provider/account/model evidence and explicit current Google processing consent are required for live Google-data validation; synthetic tests do not satisfy those gates.

The public documentation deliverable belongs in a separate `FinnaAI/matrix-os-site` PR under `content/docs/`, describing explicit API billing, provider choice, processing consent and unsupported consumer/native substitutions. Do not publish account identifiers or operator credentials.

API reference: [Models](https://developers.openai.com/api/reference/resources/models/methods/list), [Chat Completions](https://developers.openai.com/api/reference/resources/chat), [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create). Adapter registration is pinned in `packages/bot-runtime/src/providers.ts`; a new provider API requires its own adapter and policy qualification.
