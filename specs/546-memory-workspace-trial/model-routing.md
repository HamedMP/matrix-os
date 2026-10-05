# Memory model routing and judging

Status: design and research for the private memory trial. The configuration examples describe supported upstream interfaces, not enabled Matrix routes or a completed live model benchmark. Managed extraction, memory retention judging, a renewable credential bridge, and Jev reranking through Matrix require implementation and verification before being advertised as available.

## Separate the responsibilities

The generative extraction model writes candidate memory text. An embedding model produces vectors for retrieval. A judge evaluates bounded decisions such as source support, usefulness, duplication, or query relevance. Storage and canonical source revisions remain on the owner's VPS; selected content may be sent to the configured cloud inference services.

Jev is a typed decision model. It returns Noul probabilities, Choice distributions, or Score judgments against supplied criteria. It does not generate arbitrary memory text. Typed output guarantees its shape, not factual correctness, appropriate retention, or resistance to misleading source content. Owner authorization, source revision checks, deletion handling, and memory policy remain code responsibilities. [TypeSafe primitives](https://docs.typesafe.ai/primitives), [TypeSafe API](https://docs.typesafe.ai/api).

## Pinned engine interfaces

The trial pins `hindsight-api-slim==0.10.2` and `openviking==0.4.23`. The pinned Hindsight configuration and reranker source, and the pinned OpenViking reranker configuration, were inspected during the trial. Current upstream documentation corroborates the fields below; documentation alone does not establish live compatibility with a particular model or gateway.

| Responsibility                | Hindsight 0.10.2                                                                                                                                                                                                         | OpenViking 0.4.23                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI-compatible extraction  | `HINDSIGHT_API_LLM_PROVIDER=openai`, `HINDSIGHT_API_LLM_BASE_URL`, `HINDSIGHT_API_LLM_API_KEY`, `HINDSIGHT_API_LLM_MODEL`                                                                                                | `vlm.provider="openai"`, `vlm.api_base`, `vlm.api_key`, `vlm.model`                                                                              |
| Extraction operation override | `HINDSIGHT_API_RETAIN_LLM_PROVIDER`, `HINDSIGHT_API_RETAIN_LLM_BASE_URL`, `HINDSIGHT_API_RETAIN_LLM_API_KEY`, `HINDSIGHT_API_RETAIN_LLM_MODEL`                                                                           | VLM configuration is separate from embedding configuration                                                                                       |
| OpenAI-compatible embeddings  | `HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai`, `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL`, `HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY`, `HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL`, `HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS` | `embedding.dense.provider="openai"`, `embedding.dense.api_base`, `embedding.dense.api_key`, `embedding.dense.model`, `embedding.dense.dimension` |
| Jev relevance judging         | `HINDSIGHT_API_RERANKER_PROVIDER=typesafe`                                                                                                                                                                               | `rerank.provider="jev"`                                                                                                                          |
| Owner-local storage           | Local PostgreSQL database with pgvector                                                                                                                                                                                  | Local workspace, AGFS, and vector backend                                                                                                        |

The OpenAI extraction interface uses Chat Completions. A custom base URL normally includes `/v1`, with the SDK appending `/chat/completions`. Hindsight's separate `openai-responses` provider targets the Responses API and must not be pointed at a chat-only route. Hindsight uses structured extraction: its default soft path requests a JSON object with schema instructions; `HINDSIGHT_API_LLM_STRICT_SCHEMA=true` enables strict JSON schema where the upstream supports it. Per-operation strictness and provider support must be verified rather than assumed. [Hindsight models](https://hindsight.vectorize.io/developer/models), [Hindsight configuration](https://hindsight.vectorize.io/developer/configuration).

OpenViking supports an independent `vlm.api_base`, retry and concurrency limits, and model-specific `reasoning_effort` or `extra_request_body` fields. A text-only memory trial does not prove vision or media support. Changing an embedding model or dimension requires inspecting existing collections and planning reindexing. The managed Matrix extraction route does not imply a managed embedding route. [OpenViking model configuration](https://docs.openviking.ai/en/guides/01-configuration), [OpenViking server configuration](https://docs.openviking.ai/en/configuration/01-server).

## Native Jev rerank configuration

Hindsight's supported provider name is `typesafe`; its fields are:

```text
HINDSIGHT_API_RERANKER_PROVIDER=typesafe
HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY=<owner credential>
HINDSIGHT_API_RERANKER_TYPESAFE_MODEL=jev-latest
HINDSIGHT_API_RERANKER_TYPESAFE_BASE_URL=https://api.typesafe.ai
HINDSIGHT_API_RERANKER_TYPESAFE_TIMEOUT=30
HINDSIGHT_API_RERANKER_TYPESAFE_MAX_CONCURRENT=2
HINDSIGHT_API_RERANKER_TYPESAFE_PRUNE_CANDIDATES=false
```

The pinned adapter ranks candidates together with Choice. Optional pruning adds a Score question about the depth of the relevant shortlist. Returned ordering scores must not be interpreted as confidence or compared as absolute relevance probabilities across pools. [Hindsight TypeSafe configuration](https://hindsight.vectorize.io/developer/configuration).

OpenViking's supported provider name is `jev`:

```json
{
  "rerank": {
    "provider": "jev",
    "api_base": "https://api.typesafe.ai",
    "api_key": "<owner credential>",
    "model": "jev-latest",
    "mode": "noul",
    "timeout": 30,
    "threshold": 0.1,
    "log_payloads": false
  }
}
```

`noul` scores each candidate independently. `choice` compares the candidate pool and requires a threshold of zero. The same model can therefore produce different rankings and score meanings across the two engines. Keep full rerank payload logging disabled because queries and documents may contain personal material. [OpenViking rerank fields](https://docs.openviking.ai/en/configuration/01-server).

Direct TypeSafe access requires an owner API key. Its protocol is `POST /v1/systemone` with Bearer authentication and a body containing `model`, `state`, and `questions`; the direct model alias is `jev-latest`. Choice accepts at most 255 options. Record the resolved model returned by the service rather than treating an alias as an immutable version. [TypeSafe API](https://docs.typesafe.ai/api).

## Matrix managed route gaps

At research inspection, Matrix's managed OpenAI request schema in `packages/proxy/src/funded-relay-openai-request.ts` was strict and omitted `response_format`. Consequently Hindsight's structured extraction requests could not pass unchanged. This is a Matrix interface gap, even though the upstream GLM model documents structured output support.

That managed chat route accepts the explicitly supported `@cf/zai-org/glm-5.3-flash` model, text messages and tools. It does not establish support for arbitrary model IDs, embedding calls, Responses, or remote image inputs. GLM's documented reasoning levels are `low`, `high`, and `max`; reasoning cannot be disabled. Verify bounded structured output and actual engine ingestion before selecting it for extraction. [Cloudflare GLM Flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/).

Matrix already has a managed Jev route through Cloudflare. `packages/proxy/src/funded-relay-evaluation.ts` constrains it to seven exact email-triage questions, and `packages/contracts/src/jev.ts` exposes the fixed `email-triage-v1` recipe. The existing `/v1/evaluate` interface does not accept custom retention questions or the native engines' relevance protocol. Do not point native `/v1/systemone` clients at that route and claim compatibility.

A separate TypeSafe key is unnecessary for a future Matrix-managed route: the existing relay uses Cloudflare's managed credential for `typesafe/jev`. Cloudflare documents the model, typed question protocol, a 32,000-token context window, and input-only pricing. Actual owner eligibility, route readiness, affordable admission, and settlement remain required. Direct owner-funded TypeSafe access is a separate option. [Cloudflare Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/).

The proposed bridge runs on the owner's VPS and exposes operator-configured loopback interfaces to the two engines. It obtains renewable owner/runtime-bound credentials through `MatrixFundedCredentialProvider` in `packages/gateway/src/funded-ai-credential-manager.ts`, uses the background request class for ingestion, and preserves current budget reservations, policy, queue bounds, timeouts, and cancellation. Never put a temporary funded token in long-lived engine configuration or distribute platform provider credentials to engines.

The bridge needs bounded structured-output compatibility for extraction and explicit versioned recipes for retention and relevance. Native Jev adapters need protocol translation plus validated Choice, Score, and Noul responses. The initial implementation should keep supported task shapes explicit rather than opening an unrestricted upstream proxy. Embeddings need their own configured provider, credential, model, dimension, and cost receipts.

## Proposed retention workflow

Keep user-selected originals in Library. A retention gate controls derived memory and future automatic Chat learning; it must not silently discard an original that the owner explicitly imported.

1. Produce bounded candidate text with the extraction model and attach exact source IDs and revisions in code.
2. Supply the candidate, source evidence, retention policy, and bounded nearby existing memories to the judge.
3. Ask independent questions for source support, lasting usefulness, duplication, contradiction, and excluded sensitive information. Use Choice only for a bounded set of destinations such as preference, person, project, event, or review.
4. Combine answers in deterministic policy. Uncertain or contradictory candidates abstain or enter review. Authorization, provenance, and deletion checks are never delegated to the model.
5. Calibrate action thresholds against human judgments and record policy and resolved model versions. Re-evaluate changed source revisions instead of making an old judgment permanent.

This is planned work. The selected-source ingestion trial does not by itself implement continuous per-interaction retention or self-improvement. Jev relevance reranking is also distinct from deciding whether something belongs in persistent memory. [TypeSafe primitives](https://docs.typesafe.ai/primitives), [TypeSafe confidence](https://docs.typesafe.ai/confidence).

## Three-factor benchmark

Run separate comparisons so an improvement can be attributed to its cause:

| Factor             | Comparison                                     | Hold constant                                                                               |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Memory engine      | Hindsight versus OpenViking                    | Reviewed corpus, source revisions, extraction model, embedding model and dimensions         |
| Retrieval judgment | Reranking off versus Jev on                    | Engine, ingested corpus, extraction settings, test queries and result limits                |
| Retention judgment | Rules versus generative-model judge versus Jev | Candidate evidence, retention policy, labeled interactions and downstream retrieval queries |

Measure retention precision and recall, unsupported writes, duplicate writes, contradiction handling, and abstention coverage. Measure retrieval recall, precision, MRR, irrelevant-hit rates, source citation validity, latency, and total cloud cost. Include temporal corrections, deletion, sensitive exclusions, malicious source instructions, stale revisions, and queries with no relevant answer.

Use held-out human labels as the primary ground truth; do not let Jev grade its own decisions as the only oracle. Separate threshold calibration cases from final evaluation cases. Record corpus hashes, exact engine versions, resolved model versions, policy versions, real usage, retries, failures, and unavailable routes. An unavailable route is not a zero-quality score. Equal rerank models do not make engine candidate generation or native score scales identical.

Managed GLM extraction with Jev judgments is an inexpensive candidate configuration to test, not a validated default. Embedding costs and the number of extraction, consolidation, and judging calls per source can dominate ingestion; report actual receipts rather than projecting cost from one model call.
