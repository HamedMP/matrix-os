"""Bind only verified Source reader version1 while keeping preview admission disabled."""
import argparse,copy,datetime,importlib.util,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('disabled_source',ROOT/'configure-source-disabled.py');base=importlib.util.module_from_spec(sp);sp.loader.exec_module(base)
BINDING={'name':'GITHUB_TOKEN','valueSource':{'secretKeyRef':{'secret':'matrix-pair-preview-source-github-token','version':'1'}}}
def build_reader_patch(service,config):
 original=service['template']['containers'][0]['env'];by={x['name']:x for x in original}
 if len(by)!=len(original):raise ValueError('Duplicate environment names')
 if any(by.get(k)!={'name':k,'value':v} for k,v in config.items()):raise ValueError('Reviewed disabled Source settings must already be present')
 if 'GITHUB_TOKEN' in by and by['GITHUB_TOKEN']!=BINDING:raise ValueError('Conflicting existing credential binding')
 cleaned=copy.deepcopy(service);cleaned['template']['containers'][0]['env']=[x for x in cleaned['template']['containers'][0]['env'] if x['name']!='GITHUB_TOKEN']
 patch=base.build_patch(cleaned,config)
 patch['template']['containers'][0]['env']=copy.deepcopy(original) if 'GITHUB_TOKEN' in by else copy.deepcopy(original)+[copy.deepcopy(BINDING)]
 return patch

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 verification=json.loads((ROOT/'source-token-verification-receipt.json').read_text())
 if verification.get('result')!='PASS' or verification.get('version')!='1' or verification.get('owner')!='HamedMP':raise RuntimeError('Verified dedicated token receipt required')
 checked=datetime.datetime.fromisoformat(verification['checkedAt'])
 if datetime.datetime.now(datetime.timezone.utc)-checked>datetime.timedelta(minutes=30):raise RuntimeError('Refresh credential verification first')
 config=json.loads((ROOT/'source-env.disabled.json').read_text());cloud=base.Cloud()
 before={s:cloud.request(base.PREFIX+s) for s in base.SERVICES};patches={s:build_reader_patch(before[s],config) for s in base.SERVICES}
 for s in base.SERVICES:cloud.validate(patches[s]);print('Pinned reader configuration validated: '+s,flush=True)
 for s in base.SERVICES:
  if cloud.request(base.PREFIX+s)['etag']!=before[s]['etag']:raise RuntimeError('Source changed while preparing; refresh first')
 receipt={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'secret':'matrix-pair-preview-source-github-token','version':'1','expiryDateReportedByOwner':'2026-11-22','githubExpiryHeader':verification.get('githubExpiryHeader'),'mode':'apply' if args.apply else 'validate-only','admissionEnabled':False,'maintenanceEnabled':False,'services':{}}
 for s in base.SERVICES:
  if args.apply:
   current=next((x for x in before[s]['template']['containers'][0]['env'] if x['name']=='GITHUB_TOKEN'),None)
   if current!=BINDING:cloud.wait(cloud.request(base.PREFIX+s,patches[s]));print('Pinned Source reader bound: '+s,flush=True)
  after=cloud.request(base.PREFIX+s)
  if args.apply:
   actual=copy.deepcopy(after['template']['containers']);wanted=copy.deepcopy(patches[s]['template']['containers'])
   for group in [actual,wanted]:
    for c in group:c['env']=sorted(c['env'],key=lambda x:x['name'])
   if actual!=wanted:raise RuntimeError('Container readback mismatch; inspect before retrying')
   traffic=[x for x in after.get('trafficStatuses',[]) if x.get('percent',0)>0]
   if len(traffic)!=1 or traffic[0].get('percent')!=100 or traffic[0].get('revision')!=after['latestReadyRevision'].split('/')[-1]:raise RuntimeError('New revision is not exclusively serving')
   if after.get('reconciling') or after['terminalCondition']['state']!='CONDITION_SUCCEEDED':raise RuntimeError('Source is not ready')
  elif after['etag']!=before[s]['etag']:raise RuntimeError('Source changed during validation')
  receipt['services'][s]={'generation':after.get('generation'),'priorRevision':before[s].get('latestReadyRevision'),'latestReadyRevision':after.get('latestReadyRevision'),'validated':True,'applied':args.apply,'image':after['template']['containers'][0]['image']}
 path=ROOT/('source-reader-bound-receipt.json' if args.apply else 'source-reader-validation.json');path.write_text(json.dumps(receipt,indent=2)+'\n');path.chmod(0o600);print(json.dumps(receipt))
if __name__=='__main__':
 try:main()
 except (RuntimeError,ValueError,KeyError,TypeError,OSError) as e:
  print('Source reader configuration stopped: '+str(e));raise SystemExit(1)
