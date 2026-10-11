"""Bounded, data-only contract for the trusted controller/root lease boundary."""
import hashlib
import json
import re

LIMITS = dict(unitWorkers=16, cpu=30, memoryMiB=114688, workMiB=65536,
              tmpMiB=8192, homeMiB=1024, pids=4096, shmMiB=2048)
REQUEST_KEYS = frozenset(('repository', 'prNumber', 'headSha', 'baseSha', 'baseRef',
    'mergeSha', 'mergeParents', 'requestingRunId', 'requestingRunAttempt',
    'controllerRunId', 'controllerRunAttempt', 'controllerSha', 'controllerRef',
    'controllerWorkflow', 'imageDigest', 'harnessDigest', 'mode', 'suite', 'limits'))
MAX_RECORD = 16 * 1024


def canonical_digest(value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                         allow_nan=False).encode('utf8')
    if len(encoded) > MAX_RECORD:
        raise ValueError('Lease tuple exceeds bound')
    return hashlib.sha256(encoded).hexdigest()


def hex_value(value, length):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{' + str(length) + '}', value) is not None


def branch(value):
    if not isinstance(value, str) or not 0 < len(value.encode('utf8')) <= 1024:
        return False
    return not (value.startswith(('-', '/')) or value.endswith(('/', '.')) or value == '@'
        or any(x in value for x in ('..', '//', '@{', '\\'))
        or re.search(r'[\x00-\x20\x7f~^:?*\[]', value)
        or any(part.startswith('.') or part.endswith('.lock') for part in value.split('/')))


def validate_envelope(value, config):
    if not isinstance(value, dict) or set(value) != {'protocolVersion', 'leaseId', 'capability', 'request'}:
        raise ValueError('Invalid lease envelope')
    if type(value['protocolVersion']) is not int or value['protocolVersion'] != 1:
        raise ValueError('Unsupported lease protocol')
    if not hex_value(value['leaseId'], 32) or not hex_value(value['capability'], 64):
        raise ValueError('Invalid lease ownership')
    request = value['request']
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        raise ValueError('Unbound lease tuple')
    if request['repository'] != 'HamedMP/matrix-os' or request['repository'] != config['repository']:
        raise ValueError('Repository not approved')
    for key in ('prNumber', 'requestingRunId', 'requestingRunAttempt', 'controllerRunId', 'controllerRunAttempt'):
        if type(request[key]) is not int or not 0 < request[key] <= 9007199254740991:
            raise ValueError('Invalid requesting/controller identity')
    if not all(hex_value(request[key], 40) for key in ('headSha', 'baseSha', 'mergeSha', 'controllerSha')):
        raise ValueError('Invalid exact source identity')
    if request['headSha'] == request['baseSha'] or request['mergeParents'] != [request['baseSha'], request['headSha']]:
        raise ValueError('Merge parents do not bind the exact head and base')
    if not branch(request['baseRef']):
        raise ValueError('Invalid parent ref')
    if (request['controllerRef'] != 'refs/heads/main'
            or request['controllerWorkflow'] != '.github/workflows/ci-dedicated.yml'
            or request['controllerSha'] not in config['controllerShas']):
        raise ValueError('Controller not approved')
    if (request['imageDigest'] != config['imageDigest']
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', request['imageDigest'])
            or not hex_value(request['harnessDigest'], 64)
            or request['harnessDigest'] != config['harnessDigest']):
        raise ValueError('Execution inputs not approved')
    if request['mode'] not in config['modes'] or request['mode'] not in ('shadow', 'delegated'):
        raise ValueError('Qualification mode not approved')
    if request['suite'] != 'qualification' or request['limits'] != LIMITS:
        raise ValueError('Execution scope/limits not approved')
    if not isinstance(request['limits'], dict) or any(type(n) is not int for n in request['limits'].values()):
        raise ValueError('Invalid literal limits')
    canonical_digest(value)
    return value
