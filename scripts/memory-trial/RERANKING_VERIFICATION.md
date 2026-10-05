# Pinned no-cloud-reranking verification

Checked 2026-10-05 against official PyPI source distributions, downloaded with bounded timeouts and verified against registry SHA-256 values. No model credentials, personal data or inference requests were used.

| Engine | Exact pin | Official source archive SHA-256 | Behavior |
|---|---|---|---|
| Hindsight | `hindsight-api-slim==0.10.2` | `f666167f1c83144a129e06431f46b86ee27c8e028c9b82eadc9860a7a6b437d4` | `HINDSIGHT_API_RERANKER_PROVIDER=rrf` instantiates `RRFPassthroughCrossEncoder` and preserves retrieval fusion order without a model. |
| OpenViking | `openviking==0.4.23` | `94d5ad91303a38ce70eed6ab4015ec943b568989a7ac2e81c563ae76fb8b5406` | Omit `rerank`; unavailable empty rerank config means no client and default QUICK retrieval using vector scores. |

Hindsight source: `hindsight_api/engine/cross_encoder.py`, `RRFPassthroughCrossEncoder` at line 1255; `_create_cross_encoder_backend` registers provider `rrf` at line 2360. Its initialization needs no model and `_predict` returns neutral `0.5` per query/document pair. The exact class methods were executed with two synthetic pairs using a stub base: `[0.5, 0.5]`. No other package module or cloud configuration was imported in this component spike.

OpenViking source: `openviking_cli/utils/config/rerank_config.py`, `_effective_provider` and `is_available` with all provider credentials unset return `None` and `False`. These exact methods were executed with a synthetic empty config. `openviking/retrieve/hierarchical_retriever.py` constructs no rerank client when config is absent/unavailable and selects QUICK mode. Candidate vector scores remain the final scores; optional event-time decay is upstream of that ordering.

This is an explicit comparison of the engines' own pipelines without neural reranking. Hindsight's multi-strategy fusion is different from OpenViking's vector recall; equal OpenAI models and equal corpus do not make their algorithms or score scales equivalent. The generated configuration receipt records this difference and does not claim live ingestion verification.

The installer repeats the source component check against installed distributions with `verify-reranking.py` before starting services. Actual service startup, cloud extraction/embedding access, source ingestion, retrieval, update and deletion require separate live checks on the authorized private owner VPS.

Additional pinned configuration checks: Hindsight `config.py` recognizes `HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS`, `HINDSIGHT_API_RETAIN_CHUNK_SIZE`, `HINDSIGHT_API_DB_POOL_MIN_SIZE`, `HINDSIGHT_API_DB_POOL_MAX_SIZE`, `HINDSIGHT_API_LLM_BASE_URL`, `HINDSIGHT_API_LLM_TIMEOUT`, `HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS` and `HINDSIGHT_API_EMBEDDINGS_MAX_CONCURRENT_REQUESTS`. The trial sets retain output to 16000, chunks to 3000 characters and pool bounds to 2–10. OpenViking's pinned `vlm_config.py` recognizes `api_base`, `api_key`, `timeout`, `max_concurrent` and `max_retries`; `embedding_config.py` recognizes dense `dimension` and parent `max_concurrent`.

The pinned Hindsight `OpenAIEmbeddings.initialize()` and OpenViking `OpenAIDenseEmbedder` construct OpenAI SDK clients without an explicit request timeout. Their current configuration models expose no per-request OpenAI embedding timeout override; the installer records SDK defaults instead of inventing a variable or claiming a 30-second embedding deadline. OpenViking uses the configured vector dimension locally; its official OpenAI path does not send a `dimensions` request parameter and may truncate output. The baseline 1536 matches `text-embedding-3-small`'s native dimension, avoiding that difference in this trial.

Primary references: [Hindsight pinned release](https://pypi.org/project/hindsight-api-slim/0.10.2/), [Hindsight pinned source](https://github.com/vectorize-io/hindsight/blob/5fc4ce20917b916240cef27c212c387a177f115b/hindsight-api-slim/hindsight_api/engine/cross_encoder.py), [OpenViking pinned release](https://pypi.org/project/openviking/0.4.23/), [OpenViking pinned retrieval source](https://github.com/volcengine/OpenViking/blob/df32bf6e50a40843438f9491a26069ca4bd08f1f/openviking/retrieve/hierarchical_retriever.py).
