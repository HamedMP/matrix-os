#!/usr/bin/env python3
"""Render protected local trial config and a secret-free comparison receipt."""
import json
import os
import pathlib
import stat
import sys
import urllib.parse

ROOT = pathlib.Path('/etc/matrix/memory-trial')
STATE = pathlib.Path('/var/lib/matrix-memory-trial')
OPENAI_BASE_URL = 'https://api.openai.com/v1'
REQUIRED = [
    'MATRIX_MEMORY_HINDSIGHT_DATABASE_URL', 'MEMORY_TRIAL_LLM_MODEL',
    'MEMORY_TRIAL_EMBEDDING_MODEL', 'MEMORY_TRIAL_EMBEDDING_DIMENSION',
    'MEMORY_TRIAL_OPENAI_API_KEY',
]
PINS = {
    'hindsight': {'package': 'hindsight-api-slim', 'version': '0.10.2',
                  'sourceCommit': '5fc4ce20917b916240cef27c212c387a177f115b',
                  'sdistSha256': 'f666167f1c83144a129e06431f46b86ee27c8e028c9b82eadc9860a7a6b437d4'},
    'openviking': {'package': 'openviking', 'version': '0.4.23',
                   'sourceCommit': 'df32bf6e50a40843438f9491a26069ca4bd08f1f',
                   'sdistSha256': '94d5ad91303a38ce70eed6ab4015ec943b568989a7ac2e81c563ae76fb8b5406'},
}

def reranking_mode(env):
    mode = env.get('MEMORY_TRIAL_RERANKING', 'none')
    if mode not in ('none', 'cohere'):
        raise ValueError('Choose none or explicit Cohere reranking')
    return mode

def extraction_access(env):
    base = env.get('MEMORY_TRIAL_LLM_BASE_URL', OPENAI_BASE_URL)
    if not isinstance(base, str) or not base or len(base) > 2048 or any(ord(c) < 33 for c in base):
        raise ValueError('Operator extraction endpoint is invalid')
    endpoint = urllib.parse.urlparse(base)
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username is not None or endpoint.password is not None or endpoint.query or endpoint.fragment:
        raise ValueError('Use a protected HTTPS OpenAI-compatible extraction endpoint')
    if endpoint.port is not None and not 1 <= endpoint.port <= 65535:
        raise ValueError('Operator extraction endpoint port is invalid')
    # Never silently send the existing OpenAI credential to a different endpoint.
    key = env.get('MEMORY_TRIAL_LLM_API_KEY', env.get('MEMORY_TRIAL_OPENAI_API_KEY')
                  if base == OPENAI_BASE_URL else None)
    if not isinstance(key, str) or not key or len(key) > 8192 or '\n' in key or '\r' in key:
        raise ValueError('Explicit extraction credential is required for a custom endpoint')
    return base, key

def configuration(env):
    required = REQUIRED + (['MEMORY_TRIAL_COHERE_API_KEY', 'MEMORY_TRIAL_RERANK_MODEL']
                           if reranking_mode(env) == 'cohere' else [])
    if any(not isinstance(env.get(key), str) or not env[key] or
           '\n' in env[key] or '\r' in env[key] for key in required):
        raise ValueError('Required trial model or database configuration is missing or invalid')
    database = urllib.parse.urlparse(env['MATRIX_MEMORY_HINDSIGHT_DATABASE_URL'])
    if database.scheme not in ('postgres', 'postgresql') or database.hostname not in (
            'localhost', '127.0.0.1', '::1') or not database.path.strip('/'):
        raise ValueError('Trial Hindsight database must be local PostgreSQL')
    dimension = int(env['MEMORY_TRIAL_EMBEDDING_DIMENSION'])
    if dimension < 1 or dimension > 8192:
        raise ValueError('Embedding dimension is invalid')
    key = env['MEMORY_TRIAL_OPENAI_API_KEY']
    llm_base, llm_key = extraction_access(env)
    hindsight = {
        # Loopback-only DB: avoid asyncpg probing protected owner-home TLS key files.
        'HINDSIGHT_API_DATABASE_URL': urllib.parse.urlunparse(database._replace(query=urllib.parse.urlencode(
            [(name, value) for name, value in urllib.parse.parse_qsl(database.query) if name != 'sslmode']
            + [('sslmode', 'disable')]))),
        'HINDSIGHT_API_WORKER_ID': 'matrix-memory-trial',
        'HINDSIGHT_API_LLM_PROVIDER': 'openai',
        'HINDSIGHT_API_LLM_MODEL': env['MEMORY_TRIAL_LLM_MODEL'],
        'HINDSIGHT_API_LLM_API_KEY': llm_key,
        'HINDSIGHT_API_LLM_BASE_URL': llm_base,
        'HINDSIGHT_API_LLM_TIMEOUT': '30',
        'HINDSIGHT_API_LLM_MAX_CONCURRENT': '2',
        'HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS': '16000',
        'HINDSIGHT_API_RETAIN_CHUNK_SIZE': '3000',
        'HINDSIGHT_API_DB_POOL_MIN_SIZE': '2',
        'HINDSIGHT_API_DB_POOL_MAX_SIZE': '10',
        'HINDSIGHT_API_EMBEDDINGS_PROVIDER': 'openai',
        'HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY': key,
        'HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL': env['MEMORY_TRIAL_EMBEDDING_MODEL'],
        'HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS': str(dimension),
        'HINDSIGHT_API_EMBEDDINGS_MAX_CONCURRENT_REQUESTS': '2',
        # Actual supported 0.10.2 provider: no model, neutral scores preserve retrieval fusion.
        'HINDSIGHT_API_RERANKER_PROVIDER': 'rrf',
    }
    viking = {
        'server': {'host': '127.0.0.1', 'port': 1933, 'cors_origins': []},
        'storage': {'workspace': str(STATE / 'openviking'),
                    'agfs': {'backend': 'local'}, 'vectordb': {'backend': 'local'}},
        'embedding': {'dense': {'provider': 'openai', 'api_base': 'https://api.openai.com/v1',
                                'api_key': key, 'model': env['MEMORY_TRIAL_EMBEDDING_MODEL'],
                                'dimension': dimension}, 'max_concurrent': 2},
        'vlm': {'provider': 'openai', 'api_base': llm_base, 'api_key': llm_key,
                'model': env['MEMORY_TRIAL_LLM_MODEL'], 'timeout': 30,
                'max_concurrent': 2, 'max_retries': 2},
        # No rerank section: 0.4.23 selects QUICK mode and vector scores without a client.
    }
    if reranking_mode(env) == 'cohere':
        cohere = env['MEMORY_TRIAL_COHERE_API_KEY']
        hindsight.update({
            'HINDSIGHT_API_RERANKER_PROVIDER': 'cohere',
            'HINDSIGHT_API_RERANKER_COHERE_API_KEY': cohere,
            'HINDSIGHT_API_RERANKER_COHERE_MODEL': env['MEMORY_TRIAL_RERANK_MODEL'],
            'HINDSIGHT_API_RERANKER_COHERE_TIMEOUT': '30',
        })
        viking['rerank'] = {'provider': 'cohere', 'api_key': cohere,
                            'model': env['MEMORY_TRIAL_RERANK_MODEL'],
                            'timeout': 30, 'log_payloads': False}
    return hindsight, viking

def benchmark_receipt(env):
    """Configuration provenance, not a claim that ingestion or live retrieval succeeded."""
    configuration(env)
    cloud = reranking_mode(env) == 'cohere'
    return {
        'schemaVersion': 1,
        'comparisonMode': 'cloud-reranking' if cloud else 'without-model-reranking',
        'status': 'configured-not-live-verified',
        'models': {'extraction': {'provider': 'openai-compatible', 'model': env['MEMORY_TRIAL_LLM_MODEL'],
                                  'endpoint': 'openai' if extraction_access(env)[0] == OPENAI_BASE_URL else 'operator-configured'},
                   'embedding': {'provider': 'openai', 'model': env['MEMORY_TRIAL_EMBEDDING_MODEL'],
                                 'dimension': int(env['MEMORY_TRIAL_EMBEDDING_DIMENSION'])}},
        'engines': {
            'hindsight': {**PINS['hindsight'], 'reranking': {
                'mode': 'cohere' if cloud else 'rrf_passthrough', 'cloudCalls': cloud,
                'model': env['MEMORY_TRIAL_RERANK_MODEL'] if cloud else None,
                'ordering': 'Cohere scores over fused candidates' if cloud else
                            'Semantic, keyword, graph and temporal retrieval fusion; no neural reranking'}},
            'openviking': {**PINS['openviking'], 'reranking': {
                'mode': 'cohere' if cloud else 'vector_similarity', 'cloudCalls': cloud,
                'model': env['MEMORY_TRIAL_RERANK_MODEL'] if cloud else None,
                'ordering': 'Cohere scores over vector candidates' if cloud else
                            'Global scoped vector recall in QUICK mode; no rerank client'}},
        },
        'rankingAlgorithmsEqual': False,
        'trialLimits': {'hindsightRetainMaxCompletionTokens': 16000, 'hindsightRetainChunkChars': 3000,
                         'hindsightDatabasePool': {'min': 2, 'max': 10},
                         'modelConcurrency': 2, 'llmRequestTimeoutSeconds': 30,
                         'embeddingRequestTimeout': 'OpenAI SDK default; these pinned adapters expose no per-request timeout override'},
        'note': 'Compare the full engine pipelines. Equal models and no cloud reranking do not make candidate generation or score scales identical.',
        'verification': {'pinnedSourceInspected': True, 'installedRuntimeVerified': False,
                         'syntheticIngestionVerified': False},
    }

def write_exclusive(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, 'w') as output:
        # Installer umask 077 must not remove the intended service-group read bit.
        os.fchmod(output.fileno(), 0o640)
        output.write(text)

def main():
    if sys.argv[1:] != ['--private-owner-trial'] or os.geteuid() != 0:
        raise ValueError('Run only on an authorized private owner trial VPS')
    fd = os.open(ROOT / 'operator.json', os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536 or info.st_mode & 0o077 or info.st_uid != 0:
            raise ValueError('Operator configuration must be a private root-owned regular file')
        env = json.load(source)
    hindsight, viking = configuration(env)
    receipt = benchmark_receipt(env)
    outputs = {
        'hindsight.env': ''.join(key + '=' + json.dumps(value) + '\n' for key, value in hindsight.items()),
        'ov.conf': json.dumps(viking, indent=2) + '\n',
        'configuration.receipt.json': json.dumps(receipt, indent=2) + '\n',
    }
    for name in outputs:
        if (ROOT / name).exists() or (ROOT / name).is_symlink():
            raise ValueError('Trial configuration already exists; inspect it before changing models')
    for name, text in outputs.items():
        write_exclusive(ROOT / name, text)
    print('Private trial engine configuration prepared.')

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError):
        print('Trial configuration could not be prepared. Check protected operator configuration and existing files.', file=sys.stderr)
        sys.exit(1)
