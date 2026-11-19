"""Install only the approved four secrets into the verified protected control environment."""
import argparse
import json
import pathlib
import re
import subprocess
import sys

ROOT=pathlib.Path(__file__).resolve().parent
REPO='HamedMP/matrix-os'
ENV='collaboration-preview-control'
PROJECT='matrix-os-1144'
EXPECTED={
'MATRIX_PREVIEW_PAIR_OPERATOR_SECRET':'matrix-pair-preview-operator-secret',
'MATRIX_PREVIEW_PAIR_BUNDLES_ACCESS_KEY_ID':'r2-bundles-access-key-id',
'MATRIX_PREVIEW_PAIR_BUNDLES_SECRET_ACCESS_KEY':'r2-bundles-secret-access-key',
'MATRIX_PREVIEW_PAIR_RELEASE_REGISTRATION_SECRET':'platform-secret',
}

def run(args, data=None):
    result=subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45)
    if result.returncode:
        # Secret-bearing subprocess stderr is never echoed.
        raise RuntimeError('Command failed: '+args[0]+' '+args[1]+'. Check authentication/permissions in that service; no credential output was exposed.')
    return result.stdout

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true',help='Copy the reviewed pinned values from Secret Manager to the protected GitHub environment')
    args=parser.parse_args()
    subprocess.run(['python3',str(ROOT/'check-github-protections.py')],check=True,timeout=180)
    sources=json.loads((ROOT/'control-secret-sources.json').read_text())
    if set(sources)!=set(EXPECTED):
        raise RuntimeError('Unexpected secret set; nothing copied.')
    for name,ref in sources.items():
        if ref['secret']!=EXPECTED[name] or not re.fullmatch(r'[1-9][0-9]*',ref['version']):
            raise RuntimeError('Unexpected source binding; nothing copied.')
        meta=json.loads(run(['gcloud','secrets','versions','describe',ref['version'],'--secret='+ref['secret'],'--project='+PROJECT,'--format=json']))
        if meta.get('state')!='ENABLED':
            raise RuntimeError('An approved pinned version is not enabled; nothing copied.')
    if not args.apply:
        print('Prepared source versions are enabled. No secret values were read or copied.')
        print('To install them only in '+ENV+', run: python3 github-control-secrets.py --apply')
        return
    for name,ref in sources.items():
        value=run(['gcloud','secrets','versions','access',ref['version'],'--secret='+ref['secret'],'--project='+PROJECT]).strip()
        if not value or len(value)>16384:
            raise RuntimeError('Unexpected secret size; installation stopped.')
        run(['gh','secret','set',name,'--repo',REPO,'--env',ENV],value)
        value=b''
        print('Installed '+name+' into '+ENV)
    actual=json.loads(run(['gh','secret','list','--repo',REPO,'--env',ENV,'--json','name,updatedAt']))
    names={item['name'] for item in actual}
    if not set(EXPECTED).issubset(names):
        raise RuntimeError('Secret metadata readback incomplete; rerun after resolving the error.')
    print('Verified all four secret names/timestamps. GitHub cannot return their encrypted values.')
    print('No repository-level secrets, candidate credentials, Source activation, workflow dispatch or VPSes were created.')

if __name__=='__main__':
    try:
        main()
    except (RuntimeError,ValueError,KeyError,OSError,subprocess.SubprocessError) as error:
        print('Protected secret setup stopped: '+str(error),file=sys.stderr)
        raise SystemExit(1)
