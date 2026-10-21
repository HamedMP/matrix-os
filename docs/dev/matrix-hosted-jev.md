# Matrix-hosted Jev email classification

Matrix exposes a funded Jev evaluation through the owner's Gateway at `POST /api/jev/evaluate`. The current public contract has one server-owned recipe, `email-triage-v1`. It evaluates seven fixed email questions and returns independent Boolean probabilities. It does not accept custom questions, models, recipes, or a TypeSafe API key. The owner needs an authenticated Matrix runtime with Matrix AI eligibility and available funding; the primary chat or coding model can use a different provider.

For the end-to-end Gmail workflow, use the [Jev Inbox triage skill](../../skills/matrix/jev-email-triage/SKILL.md). That broker verifies the selected account, bounds mailbox reads, applies deterministic label policy, and respects the saved labeling permission. The evaluation endpoint classifies supplied text only. It neither reads Gmail nor writes labels.

## Call the owner Gateway

Send an owner-authenticated bearer to the owner's Gateway. In a trusted server or coding-agent environment, use the Matrix Gateway bearer already supplied to that runtime. Keep it out of iframe code, client bundles, logs, and repositories. A bearer for another owner, a Jev provider key, or an app-session cookie does not grant this route. The Gateway associates the request with the authenticated owner; callers cannot choose a payer, upstream endpoint, model, or question set. Matrix AI funding and route readiness are checked by the Gateway and relay before dispatch; unavailable access is reported without falling back to the primary model's provider.

This synthetic example assumes `MATRIX_GATEWAY_URL` points to the owner's Gateway and `MATRIX_OWNER_BEARER` contains an owner-authorized Gateway bearer. Obtain those values through the runtime's existing authenticated channel; do not copy a host secret into an app.

```sh
curl --fail-with-body --silent --show-error \
  --request POST "$MATRIX_GATEWAY_URL/api/jev/evaluate" \
  --header "Authorization: Bearer $MATRIX_OWNER_BEARER" \
  --header 'Content-Type: application/json' \
  --data '{
    "recipe": "email-triage-v1",
    "state": "Subject: Team lunch next week\nFrom: colleague@example.test\nSnippet: Can you confirm Tuesday works?",
    "idempotencyKey": "mailbox1:thread42:contentv1"
  }'
```

An illustrative response (probabilities, usage, and cost vary) is:

```json
{
  "requestId": "jev_req_synthetic123",
  "recipe": "email-triage-v1",
  "model": "typesafe/jev",
  "latencyMs": 135,
  "answers": [
    { "id": "urgent", "type": "boolean", "probability": 0.12 },
    { "id": "needs_reply", "type": "boolean", "probability": 0.91 },
    { "id": "personal_intro", "type": "boolean", "probability": 0.08 },
    { "id": "investment", "type": "boolean", "probability": 0.01 },
    { "id": "recruiting", "type": "boolean", "probability": 0.02 },
    { "id": "newsletter", "type": "boolean", "probability": 0.03 },
    { "id": "cold_outreach", "type": "boolean", "probability": 0.04 }
  ]
}
```

`usage`, `cost`, and `provenance` may also appear. Their absence is valid; do not infer that a request was free. Each probability is between 0 and 1. The seven answers are separate estimates, not a distribution that must sum to 1. Use your own reviewed decision policy, or the Inbox broker's built-in policy, before taking any action.

### TypeScript caller

Run this from a trusted server-side process with an owner-authorized bearer. Persist an idempotency key tied to the owner, mailbox, thread, and exact content revision before the call. Preserve that key and the exact request body for recovery.

```ts
import { JevEmailTriageResultSchema } from "@matrix-os/contracts";

const gatewayUrl = process.env.MATRIX_GATEWAY_URL;
const ownerGatewayBearer = process.env.MATRIX_OWNER_BEARER;
if (!gatewayUrl || !ownerGatewayBearer) throw new Error("Matrix Gateway access is required");

const body = {
  recipe: "email-triage-v1",
  state: "Subject: Team lunch next week\nFrom: colleague@example.test\nSnippet: Can you confirm Tuesday works?",
  idempotencyKey: "mailbox1:thread42:contentv1",
};

const response = await fetch(`${gatewayUrl}/api/jev/evaluate`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ownerGatewayBearer}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(40_000),
});
const result: unknown = await response.json();
if (!response.ok) {
  // Inspect the bounded `error.code` described below. Preserve the key and
  // body if the request may have reached Jev; a new key can charge again.
  throw new Error(`Jev evaluation returned HTTP ${response.status}`);
}
const evaluation = JevEmailTriageResultSchema.parse(result);
console.log(evaluation.requestId, evaluation.answers);
```

The `jev_evaluate` tool in the owner-authenticated Matrix MCP integration wraps this same fixed recipe for supported coding-agent contexts. It also accepts `verified` and `age_days` evidence for Matrix's deterministic triage policy and returns that policy's decision alongside the evaluation. A language model can select the evidence to submit and interpret the response, but it cannot choose questions or grant itself Gmail or funding authority. The built-in Inbox bot uses its separate `jev_inbox_preview` broker and must not call generic `jev_evaluate` to bypass its saved account and labeling rules.

## Limits and recovery

| Condition | Gateway response | Caller action |
| --- | --- | --- |
| Success | `200`, typed Jev result | Store the result and its request ID with the key. |
| Missing or invalid Gateway authentication | `401` | Renew the owner's Matrix authorization. Do not use a provider key. |
| Owner lacks Jev access or funding | `403` `denied`, or `503` `unavailable` depending on where admission fails | Check Matrix AI availability and credit; do not switch payers or providers. |
| Invalid recipe, extra fields, missing fields, or state over 32 KiB UTF-8 | `400` `invalid_request` | Correct the request before trying again. |
| JSON request body over 40 KiB | `413` `invalid_request` | Reduce the payload before trying again. |
| Same owner/key with different recipe or state | `409` `conflict` | Use a new key only for a genuinely new content revision. |
| Same owner/key still pending | `409` `in_progress` | Wait, then retry the same body and key. |
| Completed result was pruned | `410` `result_expired` | Treat the previous evaluation as spent; do not replay it blindly. |
| Dispatch outcome unknown | `503` `unknown` | Stop automatic retries and seek evidence-based reconciliation. Do not issue a new key for the same evaluation. |

The `state` must be nonempty and at most 32 KiB in UTF-8 bytes. `idempotencyKey` must be 8–240 characters, start with an ASCII letter or digit, and then contain only ASCII letters, digits, `_`, `.`, `:`, or `-`. Exact repeats with a completed key return the stored result without another dispatch while that result is retained. Completed result bodies are retained for seven days, then pruned while the key remains reserved. A transport timeout or lost response can also mean the provider ran: retry the **same** body and key to ask for a stored result, but if the Gateway reports `unknown`, stop. There is no client endpoint that can safely clear an unknown billing outcome.

## App access boundary

The app iframe fetch bridge currently rejects `/api/jev/evaluate`. An iframe cannot use the example above or inherit an owner's Gateway bearer. A trusted owner-side service or a supported Matrix agent can invoke the authenticated Gateway route; app-scoped Jev access needs a reviewed bridge capability with explicit owner consent, identity binding, funding limits, and safe result delivery. Additional server-owned recipes require their own contract and policy review. See [Chat integration support](./chat-integrations.md) for current agent route limitations.

The [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart) describes TypeSafe's direct API, SDK, and API key. Matrix's endpoint and funding contract above are defined by its [request and response schemas](../../packages/contracts/src/jev.ts) and [Gateway route](../../packages/gateway/src/jev/routes.ts); direct TypeSafe request shapes or keys are not interchangeable with Matrix's owner-authenticated recipe.

The [public developer guide](https://matrix-os.com/docs/developer/matrix-hosted-jev) covers this same contract for app and agent developers.
