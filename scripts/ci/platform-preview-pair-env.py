#!/usr/bin/env python3
"""Preserve existing Source pair settings through full Cloud Run env replacement.

Consumes only the currently serving revision's metadata. Does not read secret
values, enable the feature, authorize a pair, or import candidate configuration.
"""
import json
import re
import sys

LITERALS={
    'MATRIX_PREVIEW_PAIR_ENABLED', 'MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED',
    'MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN', 'MATRIX_PREVIEW_PAIR_MAINTAINER_ORG_ID',
    'MATRIX_PREVIEW_PAIR_IDENTITY_ISSUER', 'MATRIX_PREVIEW_PAIR_CLERK_PUBLISHABLE_KEY',
    'MATRIX_PREVIEW_PAIR_CLERK_SECRET_REF', 'MATRIX_PREVIEW_PAIR_DATABASE_SECRET_REF',
    'MATRIX_PREVIEW_PAIR_TICKET_KEYS_SECRET_REF', 'MATRIX_PREVIEW_PAIR_CONTROLLER_SHA',
    'MATRIX_PREVIEW_PAIR_SERVICE_ACCOUNT', 'MATRIX_PREVIEW_PAIR_FIXTURES',
    'MATRIX_PREVIEW_PAIR_SOURCE_PROFILE',
}
SECRETS={'MATRIX_PREVIEW_PAIR_OPERATOR_SECRET','GITHUB_TOKEN'}


def render(revision):
    entries=revision['spec']['containers'][0].get('env',[])
    if not isinstance(entries,list) or len(entries)>1000:
        raise ValueError()
    names=[item['name'] for item in entries]
    if len(set(names))!=len(names):
        raise ValueError()
    pairs=[item for item in entries if item['name'].startswith('MATRIX_PREVIEW_PAIR_')]
    if not pairs:
        return {'env':'','secrets':''}
    if any(item['name'] not in LITERALS|SECRETS for item in pairs):
        raise ValueError()
    literals=[];secrets=[]
    for item in entries:
        name=item['name']
        if name in LITERALS:
            value=item.get('value')
            if not isinstance(value,str) or len(value.encode())>65536 or '|' in value or '\x00' in value or 'valueFrom' in item:
                raise ValueError()
            if name in {'MATRIX_PREVIEW_PAIR_ENABLED','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED'} and value not in {'true','false'}:
                raise ValueError()
            literals.append('|'+name+'='+value)
        elif name in SECRETS:
            if 'value' in item:
                raise ValueError()
            ref=item['valueFrom']['secretKeyRef']
            secret=ref['name'];version=ref['key']
            if not re.fullmatch(r'(?:projects/[a-z0-9-]+/secrets/)?[a-z][a-z0-9-]{0,254}',secret):
                raise ValueError()
            if not isinstance(version,str) or not re.fullmatch(r'latest|[1-9][0-9]{0,18}',version):
                raise ValueError()
            secrets.append(','+name+'='+secret+':'+version)
    return {'env':''.join(literals),'secrets':''.join(secrets)}


def main():
    raw=sys.stdin.buffer.read(1024*1024+1)
    if len(raw)>1024*1024:
        raise ValueError()
    print(json.dumps(render(json.loads(raw))))


if __name__=='__main__':
    try:
        main()
    except (ValueError,KeyError,TypeError,IndexError,AttributeError):
        print('Preview-pair deployment configuration is invalid; refusing to discard or expose it.',file=sys.stderr)
        raise SystemExit(1)
