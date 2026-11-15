"""Receive the repo owner's dedicated read-only fine-grained token; never print/save it locally."""
import getpass
import json
import re
import subprocess
import urllib.error
import urllib.request

secret = getpass.getpass('Dedicated read-only Source GitHub fine-grained token (hidden): ')
if not re.fullmatch(r'github_pat_[A-Za-z0-9_]{50,250}', secret):
    raise SystemExit('Expected a fine-grained GitHub token; nothing was stored.')
base = 'https://api.github.com/repos/HamedMP/matrix-os'
try:
    for path in ['/pulls/3372', '/git/commits/bc47e8e3623898f83c946d13f0689e572b9a3821', '/actions/runs?per_page=1']:
        request = urllib.request.Request(base + path, headers={'Authorization':'Bearer '+secret,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
        # urllib follows API redirects by default; fixed endpoint responses must not redirect.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            body = response.read(2*1024*1024+1)
            if len(body)>2*1024*1024:
                raise ValueError('Unexpected API response size')
            json.loads(body)
except (urllib.error.URLError, ValueError, TimeoutError):
    raise SystemExit('Required read-only GitHub API checks failed; nothing was stored.')
result = subprocess.run(['gcloud','secrets','versions','add','matrix-pair-preview-source-github-token','--project=matrix-os-1144','--data-file=-'],input=secret.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
secret = ''
if result.returncode:
    raise SystemExit('Secret Manager storage failed; no token was printed or saved locally.')
print('Source GitHub token version stored. Pin the resulting enabled version before activation.')
message=(result.stdout+result.stderr).decode()
match=re.search(r'Created version \[([0-9]+)\]',message)
if match:
    print('Enabled version: '+match.group(1))
else:
    print('Read the new version number in Secret Manager before pinning it.')
# Fine-grained permission selection must also be reviewed in GitHub; successful
# public API reads alone do not prove that no additional permissions were granted.
