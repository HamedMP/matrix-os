#!/usr/bin/env python3
"""Verify pinned no-model reranking components without importing cloud configuration."""
import ast
import asyncio
import hashlib
import importlib.metadata
import json
import logging
import sys
import typing

PINS = {'hindsight': ('hindsight-api-slim', '0.10.2'), 'openviking': ('openviking', '0.4.23')}

def read_module(distribution, relative):
    path = distribution.locate_file(relative)
    if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('Pinned source module is missing or oversized')
    return path.read_text(encoding='utf8')

def class_definition(source, name):
    return next(node for node in ast.parse(source).body
                if isinstance(node, ast.ClassDef) and node.name == name)

def check_hindsight(source):
    factory = next(node for node in ast.parse(source).body
                   if isinstance(node, ast.FunctionDef) and node.name == '_create_cross_encoder_backend')
    registered = False
    for node in ast.walk(factory):
        if not isinstance(node, ast.If) or ast.unparse(node.test) != "provider == 'rrf'":
            continue
        registered = any(isinstance(item, ast.Return) and isinstance(item.value, ast.Call)
                         and isinstance(item.value.func, ast.Name)
                         and item.value.func.id == 'RRFPassthroughCrossEncoder' for item in node.body)
    if not registered:
        raise ValueError('Pinned rrf provider is not registered')
    node = class_definition(source, 'RRFPassthroughCrossEncoder')
    # Execute only this explicit component, with a stub base; no module imports/config/model keys.
    namespace = {'CrossEncoderModel': object, 'logger': logging.getLogger('trial-verification')}
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    exec(compile(module, 'installed-hindsight-passthrough', 'exec'), namespace)
    component = namespace['RRFPassthroughCrossEncoder']()
    asyncio.run(component.initialize())
    scores = asyncio.run(component._predict([('synthetic', 'one'), ('synthetic', 'two')]))
    if component.provider_name != 'rrf' or scores != [0.5, 0.5]:
        raise ValueError('Pinned rrf component does not preserve neutral scores')
    return {'capability': 'rrf_passthrough', 'syntheticNeutralScores': scores}

def check_openviking(config_source, retriever_source):
    definition = class_definition(config_source, 'RerankConfig')
    methods = [node for node in definition.body if isinstance(node, ast.FunctionDef)
               and node.name in ('_effective_provider', 'is_available')]
    if len(methods) != 2:
        raise ValueError('Pinned rerank availability checks are missing')
    node = ast.ClassDef(name='EmptyRerankConfig', bases=[], keywords=[],
                        body=methods, decorator_list=[])
    namespace = {'Optional': typing.Optional}
    module = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    exec(compile(module, 'installed-openviking-empty-rerank', 'exec'), namespace)
    config = namespace['EmptyRerankConfig']()
    for name in ('provider', 'api_base', 'api_key', 'ak', 'sk', 'model'):
        setattr(config, name, None)
    if config._effective_provider() is not None or config.is_available():
        raise ValueError('Empty pinned OpenViking config unexpectedly activates reranking')
    if 'mode = RetrieverMode.THINKING if self._rerank_client else RetrieverMode.QUICK' not in retriever_source:
        raise ValueError('Pinned vector-only mode selection does not match the trial')
    return {'capability': 'vector_similarity', 'emptyRerankAvailable': False, 'retrievalMode': 'QUICK'}

def verify(engine):
    package, version = PINS[engine]
    distribution = importlib.metadata.distribution(package)
    if distribution.version != version:
        raise ValueError('Installed engine version does not match the trial pin')
    if engine == 'hindsight':
        source = read_module(distribution, 'hindsight_api/engine/cross_encoder.py')
        result = check_hindsight(source)
    else:
        source = read_module(distribution, 'openviking_cli/utils/config/rerank_config.py')
        retriever = read_module(distribution, 'openviking/retrieve/hierarchical_retriever.py')
        result = check_openviking(source, retriever)
        result['retrieverSourceSha256'] = hashlib.sha256(retriever.encode()).hexdigest()
    return {'schemaVersion': 1, 'engine': engine, 'package': package,
            'installedVersion': version, 'sourceSha256': hashlib.sha256(source.encode()).hexdigest(),
            **result, 'networkCalls': 0,
            'verificationScope': 'Installed pinned source component; full server startup and synthetic ingestion require separate verification'}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in PINS:
            raise ValueError('Choose a pinned trial engine')
        print(json.dumps(verify(sys.argv[1]), indent=2))
    except (ValueError, OSError, KeyError, StopIteration, importlib.metadata.PackageNotFoundError):
        print('Pinned reranking capability verification failed. Trial services were not started.', file=sys.stderr)
        sys.exit(1)
