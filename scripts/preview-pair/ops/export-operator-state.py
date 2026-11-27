"""Recover private operator metadata from existing resources; never read secret values."""
import argparse, datetime, importlib.util, json, pathlib, secrets, subprocess

ROOT = pathlib.Path(__file__).resolve().parent
PIN = 'bc47e8e3623898f83c946d13f0689e572b9a3821'
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
reader = load('bind-source-reader')
base = reader.base

def extract_configuration(api, worker):
    configs = []
    for service in [api, worker]:
        entries = service['template']['containers'][0]['env']
        env = {x['name']: x for x in entries}
        if len(env) != len(entries): raise ValueError('Duplicate Source fields')
        config = {k: env[k]['value'] for k in base.FIELDS if k in env and 'value' in env[k]}
        if set(config) != base.FIELDS: raise ValueError('Incomplete Source preview metadata')
        if config['MATRIX_PREVIEW_PAIR_CONTROLLER_SHA'] != PIN: raise ValueError('Unreviewed controller pin')
        reader.build_reader_patch(service, config)
        configs.append(config)
    if configs[0] != configs[1]: raise ValueError('Source API/worker configuration differs')
    return configs[0]

def store(name, value):
    # Run a copy outside Git. Private metadata and receipts must never enter a checkout.
    if subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--show-toplevel'], capture_output=True, timeout=10).returncode == 0:
        raise ValueError('Copy ops to a private directory outside Git before exporting')
    path = ROOT / name
    with open(path, 'x', encoding='utf-8', opener=lambda p, flags: __import__('os').open(p, flags, 0o600)) as stream:
        json.dump(value, stream, indent=2); stream.write('\n')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probes', action='store_true', help='Also prepare fresh metadata-only diagnostic job plans')
    args = parser.parse_args()
    cloud = base.Cloud()
    before = {name: cloud.request(base.PREFIX + name) for name in base.SERVICES}
    config = extract_configuration(*(before[name] for name in base.SERVICES))
    for name, previous in before.items():
        if cloud.request(base.PREFIX + name)['etag'] != previous['etag']: raise ValueError('Source changed during export')
    store('source-env.disabled.json', config)
    store('control-secret-sources.json', {
        'MATRIX_PREVIEW_PAIR_OPERATOR_SECRET': {'secret': 'matrix-pair-preview-operator-secret', 'version': '1'},
        'MATRIX_PREVIEW_PAIR_BUNDLES_ACCESS_KEY_ID': {'secret': 'r2-bundles-access-key-id', 'version': '1'},
        'MATRIX_PREVIEW_PAIR_BUNDLES_SECRET_ACCESS_KEY': {'secret': 'r2-bundles-secret-access-key', 'version': '1'},
        'MATRIX_PREVIEW_PAIR_RELEASE_REGISTRATION_SECRET': {'secret': 'platform-secret', 'version': '1'},
    })
    if args.probes:
        result = subprocess.run(['gcloud', 'secrets', 'list', '--project=' + base.PROJECT, '--format=json'], capture_output=True, text=True, timeout=30, check=True)
        ids = [x['name'].split('/')[-1] for x in json.loads(result.stdout)]
        approved = ['matrix-pair-preview-' + x for x in ['clerk-secret','database-url','platform-secret','jwt-secret','edge-secret','ticket-keys']]
        if not set(approved) <= set(ids) or len(ids) > 1000: raise ValueError('Unexpected secret inventory')
        for kind in ['runtime','publisher']:
            nonce = secrets.token_hex(6)
            store(kind + '-iam-probe-plan.json', dict(job='pair-' + kind + '-probe-' + nonce, probeId=nonce,
                image=base.IMAGE, identity='matrix-pair-preview-' + kind + '@' + base.PROJECT + '.iam.gserviceaccount.com',
                secretIds=ids, approved=approved if kind=='runtime' else [], createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat()))
    print('Exported allowlisted private metadata. No secret values read; no Cloud changes; no active window or cleanup proof created.')

if __name__ == '__main__': main()
