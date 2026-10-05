#!/usr/bin/env python3
"""Validate operator secrets and render loopback-only native trial configuration. Never prints secrets."""
import json, os, pathlib, stat, sys, urllib.parse
ROOT = pathlib.Path('/etc/matrix/memory-trial')
STATE = pathlib.Path('/var/lib/matrix-memory-trial')
REQUIRED = ['MATRIX_MEMORY_HINDSIGHT_DATABASE_URL', 'MEMORY_TRIAL_LLM_MODEL', 'MEMORY_TRIAL_EMBEDDING_MODEL', 'MEMORY_TRIAL_EMBEDDING_DIMENSION', 'MEMORY_TRIAL_RERANK_MODEL', 'MEMORY_TRIAL_OPENAI_API_KEY', 'MEMORY_TRIAL_COHERE_API_KEY']
def configuration(env):
    if any(not env.get(key) or '\n' in env[key] or '\r' in env[key] for key in REQUIRED):
        raise ValueError('Required trial model or database configuration is missing or invalid')
    database = urllib.parse.urlparse(env['MATRIX_MEMORY_HINDSIGHT_DATABASE_URL'])
    if database.scheme not in ('postgres', 'postgresql') or database.hostname not in ('localhost', '127.0.0.1', '::1') or not database.path.strip('/'):
        raise ValueError('Trial Hindsight database must be local PostgreSQL')
    dimension = int(env['MEMORY_TRIAL_EMBEDDING_DIMENSION'])
    if dimension < 1 or dimension > 8192: raise ValueError('Embedding dimension is invalid')
    key, cohere = env['MEMORY_TRIAL_OPENAI_API_KEY'], env['MEMORY_TRIAL_COHERE_API_KEY']
    hindsight = {'HINDSIGHT_API_DATABASE_URL': env['MATRIX_MEMORY_HINDSIGHT_DATABASE_URL'], 'HINDSIGHT_API_WORKER_ID': 'matrix-memory-trial', 'HINDSIGHT_API_LLM_PROVIDER': 'openai', 'HINDSIGHT_API_LLM_MODEL': env['MEMORY_TRIAL_LLM_MODEL'], 'HINDSIGHT_API_LLM_API_KEY': key, 'HINDSIGHT_API_LLM_TIMEOUT': '30', 'HINDSIGHT_API_LLM_MAX_CONCURRENT': '2', 'HINDSIGHT_API_EMBEDDINGS_PROVIDER': 'openai', 'HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY': key, 'HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL': env['MEMORY_TRIAL_EMBEDDING_MODEL'], 'HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS': str(dimension), 'HINDSIGHT_API_EMBEDDINGS_MAX_CONCURRENT_REQUESTS': '2', 'HINDSIGHT_API_RERANKER_PROVIDER': 'cohere', 'HINDSIGHT_API_RERANKER_COHERE_API_KEY': cohere, 'HINDSIGHT_API_RERANKER_COHERE_MODEL': env['MEMORY_TRIAL_RERANK_MODEL'], 'HINDSIGHT_API_RERANKER_COHERE_TIMEOUT': '30'}
    viking = {'server': {'host': '127.0.0.1', 'port': 1933, 'cors_origins': []}, 'storage': {'workspace': str(STATE / 'openviking'), 'agfs': {'backend': 'local'}, 'vectordb': {'backend': 'local'}}, 'embedding': {'dense': {'provider': 'openai', 'api_base': 'https://api.openai.com/v1', 'api_key': key, 'model': env['MEMORY_TRIAL_EMBEDDING_MODEL'], 'dimension': dimension}, 'max_concurrent': 2}, 'vlm': {'provider': 'openai', 'api_base': 'https://api.openai.com/v1', 'api_key': key, 'model': env['MEMORY_TRIAL_LLM_MODEL'], 'timeout': 30, 'max_concurrent': 2, 'max_retries': 2}, 'rerank': {'provider': 'cohere', 'api_key': cohere, 'model': env['MEMORY_TRIAL_RERANK_MODEL'], 'timeout': 30, 'log_payloads': False}}
    return hindsight, viking

def write_exclusive(path, text):
    # Installer owns these fixed roots; never follow a pre-existing path or overwrite configuration.
    fd=os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd,'w') as output: output.write(text)

def main():
    if sys.argv[1:] != ['--private-owner-trial'] or os.geteuid() != 0:
        raise ValueError('Run only on an authorized private owner trial VPS')
    secret_path=ROOT/'operator.json'
    fd=os.open(secret_path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        info=os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>65536 or info.st_mode & 0o077 or info.st_uid!=0:
            raise ValueError('Operator configuration must be a private root-owned regular file')
        env=json.load(source)
    hindsight,viking=configuration(env)
    for path in (ROOT/'hindsight.env',ROOT/'ov.conf'):
        if path.exists() or path.is_symlink(): raise ValueError('Trial configuration already exists; inspect it before changing models')
    # JSON string escaping also gives systemd EnvironmentFile compatible quoted values.
    write_exclusive(ROOT/'hindsight.env',''.join(key+'='+json.dumps(value)+'\n' for key,value in hindsight.items()))
    write_exclusive(ROOT/'ov.conf',json.dumps(viking,indent=2)+'\n')
    print('Private trial engine configuration prepared.')
if __name__=='__main__':
    try: main()
    except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError):
        print('Trial configuration could not be prepared. Check protected operator configuration and existing files.',file=sys.stderr)
        sys.exit(1)
