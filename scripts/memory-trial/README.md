# Private owner memory trial services

These opt-in native services belong on an authorized owner-only preview VPS. They do not modify production releases, update channels, Matrix routing, or existing owner data. Hindsight stores data in a separately provisioned local PostgreSQL database with pgvector; OpenViking's experimental workspace and vector index stay in `/var/lib/matrix-memory-trial/openviking`. Matrix's canonical sources remain in owner Postgres.

Pins checked against official PyPI on 2026-10-05: `hindsight-api-slim==0.10.2`, `openviking==0.4.23`. Separate Python environments prevent dependency conflicts. The installer records resolved transitive versions in `hindsight-installed-requirements.txt` and `openviking-installed-requirements.txt`; this trial is not a locked production engine release. No Docker path is used.

Prerequisites: Linux/systemd, Python 3.11+, Python venv tooling, existing `matrix` service user, local Postgres 15+ with pgvector. Provision a separate database and least-privilege login for Hindsight using the existing operator Postgres provisioning path. Its database must exist with `CREATE EXTENSION vector` enabled. The setup refuses a remote database URL; it does not silently use pg0.

Configure the Matrix gateway on this same private runtime with `MEMORY_HINDSIGHT_URL=http://127.0.0.1:8888` and `MEMORY_OPENVIKING_URL=http://127.0.0.1:1933`. Leave engine API keys unset for these loopback-only trial services. The gateway must still enforce owner authorization before requests; neither URL is browser-controlled.

Create `/etc/matrix/memory-trial/operator.json` as a root-owned regular file with mode `0600`. Do not paste this file into logs, PRs or browser payloads. Required keys:

- `MATRIX_MEMORY_HINDSIGHT_DATABASE_URL`: local Postgres connection URI.
- `MEMORY_TRIAL_OPENAI_API_KEY`: extraction and embedding cloud credential.
- `MEMORY_TRIAL_COHERE_API_KEY`: cloud reranking credential.
- `MEMORY_TRIAL_LLM_MODEL`, `MEMORY_TRIAL_EMBEDDING_MODEL`, `MEMORY_TRIAL_EMBEDDING_DIMENSION`, `MEMORY_TRIAL_RERANK_MODEL`: operator-selected explicit model configuration, shared by both engines.

Run `bash scripts/memory-trial/install.sh --private-owner-trial` on that VPS. Both native services bind only to loopback (Hindsight 8888, OpenViking 1933), use bounded model concurrency, and get separate 2 GB memory caps. The script never prints credentials or reads personal imports. OpenViking uses loopback development authority behind the Matrix gateway; it is not a public engine endpoint. Do not expose its port or treat liveness as model readiness.

After installation check OpenViking `/ready`, Hindsight `/health`, service readiness, and synthetic retain/search/update/delete through Matrix. Record model names, full package receipt, corpus hashes and per-engine completion receipts. A health response alone does not prove working cloud credentials or source processing. Engine adapter readiness and canonical owner authorization remain mandatory.

Stop services before changing an embedding model/dimension; inspect and export existing engine state first. Configuration is exclusively created on first install and is never automatically overwritten. Back up canonical owner Postgres, the Hindsight database and the whole OpenViking workspace. Private previews expire after 72 hours and their VM may be removed. Back up canonical sources and engine workspaces before expiry or stopping the trial. The installer does not remove existing owner data.

References: [Hindsight installation](https://hindsight.vectorize.io/developer/installation), [Hindsight configuration](https://hindsight.vectorize.io/developer/configuration), [OpenViking native deployment](https://docs.openviking.ai/en/guides/03-deployment), [OpenViking configuration](https://docs.openviking.ai/en/guides/01-configuration), [Hindsight package pin](https://pypi.org/project/hindsight-api-slim/0.10.2/), [OpenViking package pin](https://pypi.org/project/openviking/0.4.23/).
