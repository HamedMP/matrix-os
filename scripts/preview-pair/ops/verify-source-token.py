"""Check the dedicated version1 Source token in memory; emit metadata only."""
import argparse,datetime,json,pathlib,re,subprocess,time,urllib.error,urllib.request
ROOT=pathlib.Path(__file__).resolve().parent
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):return None

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--candidate-sha',required=True);parser.add_argument('--artifact-run',type=int,required=True);args=parser.parse_args()
 if not re.fullmatch(r'[a-f0-9]{40}',args.candidate_sha) or args.artifact_run<=0:raise ValueError('Exact candidate SHA and artifact run required')
 p=subprocess.run(['gcloud','secrets','versions','access','1','--secret=matrix-pair-preview-source-github-token','--project=matrix-os-1144'],capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError('Dedicated credential unavailable')
 token=p.stdout.decode().strip();p=None
 if not re.fullmatch(r'github_pat_[A-Za-z0-9_]{50,250}',token):raise RuntimeError('Expected fine-grained credential')
 opener=urllib.request.build_opener(NoRedirect);expiry=None;checks=[]
 def get(path,redirect=False):
  nonlocal expiry
  for attempt in range(2):
   request=urllib.request.Request('https://api.github.com'+path,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
   try:
    with opener.open(request,timeout=12) as response:
     expiry=response.headers.get('github-authentication-token-expiration') or expiry
     data=response.read(2*1024*1024+1)
     if len(data)>2*1024*1024:raise RuntimeError('Unexpected response size')
     checks.append({'endpoint':path,'status':response.status});return json.loads(data)
   except urllib.error.HTTPError as error:
    code=error.code
    if redirect and code==302:
     expiry=error.headers.get('github-authentication-token-expiration') or expiry;checks.append({'endpoint':path,'status':302,'artifactBytesRead':0});error.close();return None
    error.close()
    if code>=500 and attempt==0:time.sleep(1);continue
    raise RuntimeError('Required GitHub read failed for '+path.split('?')[0]+'; status '+str(code)) from None
 who=get('/user')
 if who.get('login')!='HamedMP':raise RuntimeError('Unexpected token owner')
 pr=get('/repos/HamedMP/matrix-os/pulls/3372')
 if pr.get('state')!='open' or pr.get('head',{}).get('sha')!=args.candidate_sha:raise RuntimeError('Candidate head changed; review before activation')
 controller=get('/repos/HamedMP/matrix-os/git/commits/bc47e8e3623898f83c946d13f0689e572b9a3821')
 if controller.get('sha')!='bc47e8e3623898f83c946d13f0689e572b9a3821':raise RuntimeError('Controller mismatch')
 get('/repos/HamedMP/matrix-os/actions/workflows/preview-collaboration-pair.yml/runs?per_page=1')
 artifacts=get('/repos/HamedMP/matrix-os/actions/runs/'+str(args.artifact_run)+'/artifacts?per_page=100')
 live=next((x for x in artifacts.get('artifacts',[]) if not x.get('expired') and isinstance(x.get('id'),int)),None)
 if live is None:raise RuntimeError('No artifact available for a download-permission preflight')
 get('/repos/HamedMP/matrix-os/actions/artifacts/'+str(live['id'])+'/zip',redirect=True)
 token=''
 if expiry:
  parsed=datetime.datetime.fromisoformat(expiry.replace('Z','+00:00').replace(' UTC','+00:00'))
  if parsed<=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=8):raise RuntimeError('Insufficient credential lifetime')
 receipt={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'secret':'matrix-pair-preview-source-github-token','version':'1','tokenKind':'fine-grained','owner':'HamedMP','ownerReportedExpiryDate':'2026-11-22','githubExpiryHeader':expiry,'requiredReadChecks':checks,'candidateSha':pr['head']['sha'],'result':'PASS','scopeLimitation':'Required reads and authenticated artifact redirect verified. API does not prove absence of excess fine-grained scopes; owner completion follows the exact requested read-only permission selection.','artifactBytesRead':0,'valuesPrintedOrStored':False}
 path=ROOT/'source-token-verification-receipt.json';path.write_text(json.dumps(receipt,indent=2)+'\n');path.chmod(0o600)
 print(json.dumps(receipt))
if __name__=='__main__':
 try:main()
 except (RuntimeError,ValueError,KeyError,urllib.error.URLError,subprocess.SubprocessError) as e:
  print('Source credential verification stopped: '+str(e));raise SystemExit(1)
