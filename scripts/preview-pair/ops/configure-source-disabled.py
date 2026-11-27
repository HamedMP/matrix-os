"""Validate or apply only disabled pair configuration to existing trusted Source services."""
import argparse,copy,datetime,hashlib,json,pathlib,subprocess,time,urllib.error,urllib.parse,urllib.request
ROOT=pathlib.Path(__file__).resolve().parent
PROJECT='matrix-os-1144';REGION='europe-west3'
PREFIX=f'projects/{PROJECT}/locations/{REGION}/services/'
SERVICES=['matrix-platform','matrix-platform-worker']
IMAGE='europe-west3-docker.pkg.dev/matrix-os-1144/matrix-os/matrix-platform@sha256:0c57ccf3003648eba1efb597fec1026458f3fd732ba4b335d019b785a1d4615f'
SA='matrix-platform-runner@matrix-os-1144.iam.gserviceaccount.com'
FIELDS={'MATRIX_PREVIEW_PAIR_ENABLED','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED','MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN','MATRIX_PREVIEW_PAIR_MAINTAINER_ORG_ID','MATRIX_PREVIEW_PAIR_IDENTITY_ISSUER','MATRIX_PREVIEW_PAIR_CLERK_PUBLISHABLE_KEY','MATRIX_PREVIEW_PAIR_CLERK_SECRET_REF','MATRIX_PREVIEW_PAIR_DATABASE_SECRET_REF','MATRIX_PREVIEW_PAIR_TICKET_KEYS_SECRET_REF','MATRIX_PREVIEW_PAIR_CONTROLLER_SHA','MATRIX_PREVIEW_PAIR_SERVICE_ACCOUNT','MATRIX_PREVIEW_PAIR_FIXTURES','MATRIX_PREVIEW_PAIR_SOURCE_PROFILE'}
OPERATOR={'name':'MATRIX_PREVIEW_PAIR_OPERATOR_SECRET','valueSource':{'secretKeyRef':{'secret':'matrix-pair-preview-operator-secret','version':'1'}}}
def build_patch(service,env):
 name=service.get('name','');short=name.removeprefix(PREFIX)
 if name!=PREFIX+short or short not in SERVICES or not service.get('etag') or service.get('reconciling') or service.get('terminalCondition',{}).get('state')!='CONDITION_SUCCEEDED':raise ValueError('Source is not stable')
 if not set(env)<=FIELDS or any(not isinstance(v,str) or len(v.encode())>65536 or '\0' in v for v in env.values()):raise ValueError('Unreviewed configuration')
 if any(env.get(k)!='false' for k in ['MATRIX_PREVIEW_PAIR_ENABLED','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED']):raise ValueError('Only disabled setup is supported')
 template=copy.deepcopy(service['template']);containers=template.get('containers',[])
 if template.get('serviceAccount')!=SA or len(containers)!=1 or containers[0].get('image')!=IMAGE:raise ValueError('Unreviewed Source identity/image')
 entries=containers[0].get('env',[]);by={x['name']:x for x in entries}
 if len(by)!=len(entries) or len(entries)>256:raise ValueError('Ambiguous environment')
 if 'GITHUB_TOKEN' in by:raise ValueError('Source token already bound; use the activation procedure')
 expected='true' if short.endswith('-worker') else 'false'
 if by.get('PLATFORM_BACKGROUND_WORKERS_ENABLED',{}).get('value')!=expected:raise ValueError('Worker role mismatch')
 if any(by.get(k,{}).get('value','false')!='false' for k in ['MATRIX_PREVIEW_PAIR_ENABLED','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED']):raise ValueError('Active pairs must not be overwritten')
 if any(k.startswith('MATRIX_PREVIEW_PAIR_') and k not in FIELDS|{'MATRIX_PREVIEW_PAIR_OPERATOR_SECRET'} for k in by):raise ValueError('Unknown existing pair field')
 for k,v in env.items():
  if k in by and by[k]!={'name':k,'value':v}:raise ValueError('Conflicting pair configuration')
 if OPERATOR['name'] in by and by[OPERATOR['name']]!=OPERATOR:raise ValueError('Conflicting operator binding')
 containers[0]['env']=[x for x in entries if x['name'] not in set(env)|{OPERATOR['name']}]+[{'name':k,'value':v} for k,v in env.items()]+[copy.deepcopy(OPERATOR)]
 template.pop('revision',None)
 traffic=copy.deepcopy(service.get('traffic',[]));positive=[x for x in traffic if x.get('percent',0)>0]
 if len(positive)!=1 or positive[0].get('percent')!=100 or len(traffic)>256:raise ValueError('Split or ambiguous traffic')
 old=positive[0];new={'type':'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST','percent':100}
 if old.get('tag'):new['tag']=old['tag']
 traffic[traffic.index(old)]=new
 return {'name':name,'etag':service['etag'],'template':template,'traffic':traffic}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):return None
class Cloud:
 def __init__(self):
  p=subprocess.run(['gcloud','auth','print-access-token','--project='+PROJECT],capture_output=True,text=True,timeout=30)
  if p.returncode:raise RuntimeError('Cloud authentication unavailable')
  self.token=p.stdout.strip();self.opener=urllib.request.build_opener(NoRedirect)
 def request(self,path,body=None,validate=False):
  if not path.startswith(PREFIX) and not path.startswith(f'projects/{PROJECT}/locations/{REGION}/operations/'):raise ValueError('Unexpected resource')
  url='https://run.googleapis.com/v2/'+path
  if body is not None:url+='?'+urllib.parse.urlencode({'updateMask':'template,traffic','validateOnly':str(validate).lower()})
  req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'},method='GET' if body is None else 'PATCH')
  try:
   with self.opener.open(req,timeout=40) as response:
    raw=response.read(2*1024*1024+1)
  except urllib.error.HTTPError as e:raise RuntimeError('Cloud request failed; status '+str(e.code)) from None
  if len(raw)>2*1024*1024:raise RuntimeError('Oversized Cloud response')
  d=json.loads(raw)
  if d.get('error'):raise RuntimeError('Cloud operation rejected; code '+str(d['error'].get('code')))
  return d
 def validate(self,patch):
  # Cloud Run validateOnly returns proposed Service metadata and a non-persisted
  # operation name. Polling that name returns404; validation itself is synchronous.
  operation=self.request(patch['name'],patch,validate=True)
  metadata=operation.get('metadata',{})
  if metadata.get('@type')!='type.googleapis.com/google.cloud.run.v2.Service' or metadata.get('name')!=patch['name']:raise RuntimeError('Unexpected validation response')
  before=copy.deepcopy(patch['template']['containers']);after=copy.deepcopy(metadata.get('template',{}).get('containers',[]))
  for group in [before,after]:
   for container in group:container['env']=sorted(container.get('env',[]),key=lambda x:x['name'])
  if before!=after:raise RuntimeError('Cloud validation changed container configuration')
  return metadata
 def wait(self,operation):
  deadline=time.monotonic()+240
  while not operation.get('done'):
   if time.monotonic()>deadline:raise RuntimeError('Operation still pending; inspect before retrying')
   time.sleep(3);operation=self.request(operation['name'])
  if operation.get('error'):raise RuntimeError('Cloud update failed')
  return operation

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply-disabled',action='store_true');args=parser.parse_args()
 env=json.loads((ROOT/'source-env.disabled.json').read_text());cloud=Cloud()
 before={s:cloud.request(PREFIX+s) for s in SERVICES};patches={s:build_patch(before[s],env) for s in SERVICES}
 for s in SERVICES:
  cloud.validate(patches[s]);print('Cloud validation passed: '+s,flush=True)
 for s in SERVICES:
  if cloud.request(PREFIX+s)['etag']!=before[s]['etag']:raise RuntimeError('Source changed during preparation; refresh first')
 result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'configurationHash':hashlib.sha256(json.dumps(env,sort_keys=True).encode()).hexdigest(),'mode':'apply-disabled' if args.apply_disabled else 'validate-only','secretValueReads':0,'admissionEnabled':False,'maintenanceEnabled':False,'githubTokenBound':False,'services':{}}
 for s in SERVICES:
  if args.apply_disabled:
   cloud.wait(cloud.request(PREFIX+s,patches[s]));print('Applied disabled configuration: '+s,flush=True)
  after=cloud.request(PREFIX+s);t=after['template'];actual=t['containers'][0]
  if args.apply_disabled:
   wanted=copy.deepcopy(patches[s]['template']['containers'][0]);got=copy.deepcopy(actual)
   for c in [wanted,got]:c['env']=sorted(c['env'],key=lambda x:x['name'])
   if wanted!=got:raise RuntimeError('Container configuration readback differs; inspect before further updates')
   serving=[x for x in after.get('trafficStatuses',[]) if x.get('percent',0)>0]
   latest=after.get('latestReadyRevision','').split('/')[-1]
   if len(serving)!=1 or serving[0].get('percent')!=100 or serving[0].get('revision')!=latest:raise RuntimeError('New disabled revision is not exclusively serving')
   if after.get('reconciling') or after.get('terminalCondition',{}).get('state')!='CONDITION_SUCCEEDED':raise RuntimeError('Service not stable')
  elif after['etag']!=before[s]['etag']:raise RuntimeError('Source changed during validation')
  result['services'][s]={'priorGeneration':before[s].get('generation'),'generation':after.get('generation'),'latestReadyRevision':after.get('latestReadyRevision'),'image':actual['image'],'backgroundWorkersEnabled':next(x['value'] for x in actual['env'] if x['name']=='PLATFORM_BACKGROUND_WORKERS_ENABLED'),'validated':True,'applied':args.apply_disabled}
 path=ROOT/('source-disabled-applied-receipt.json' if args.apply_disabled else 'source-disabled-validation.json');path.write_text(json.dumps(result,indent=2)+'\n');path.chmod(0o600);print(json.dumps(result))
if __name__=='__main__':
 try:main()
 except (RuntimeError,ValueError,KeyError,TypeError,StopIteration,urllib.error.URLError,subprocess.SubprocessError) as e:
  print('Source setup stopped: '+str(e));raise SystemExit(1)
