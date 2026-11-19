"""Phased Source flag changes for the explicitly approved bounded preview window."""
import argparse,copy,datetime,importlib.util,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('reader',ROOT/'bind-source-reader.py');reader=importlib.util.module_from_spec(sp);sp.loader.exec_module(reader)
FLAGS={'MATRIX_PREVIEW_PAIR_ENABLED','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED'}
def build_phase_patch(service,config,phase):
 if phase not in {'maintenance','admission','close','off'}:raise ValueError('Unknown phase')
 original=service['template']['containers'][0]['env'];env={x['name']:x for x in original}
 if any(env.get(k,{}).get('value') not in {'true','false'} for k in FLAGS):raise ValueError('Invalid current flags')
 active=env['MATRIX_PREVIEW_PAIR_ENABLED']['value']=='true';maintenance=env['MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED']['value']=='true'
 if phase=='maintenance' and active:raise ValueError('Cannot overwrite active admission')
 if phase=='admission' and not maintenance:raise ValueError('Maintenance must be verified before admission')
 if phase=='off' and active:raise ValueError('Close admission and prove cleanup before stopping maintenance')
 cleaned=copy.deepcopy(service)
 for x in cleaned['template']['containers'][0]['env']:
  if x['name'] in FLAGS:x['value']='false'
 patch=reader.build_reader_patch(cleaned,config);patch['template']['containers'][0]['env']=copy.deepcopy(original)
 target={'MATRIX_PREVIEW_PAIR_ENABLED':'true' if phase=='admission' else 'false','MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED':'false' if phase=='off' else 'true'}
 for x in patch['template']['containers'][0]['env']:
  if x['name'] in target:x['value']=target[x['name']]
 return patch

def gh(path):
 p=subprocess.run(['gh','api',path],capture_output=True,text=True,timeout=30)
 if p.returncode:raise RuntimeError('GitHub control metadata unavailable')
 return json.loads(p.stdout)
def assert_held_stale_run(run,jobs,check_runs,target):
 reviewed={43098186361:'cc366b2385dc76358539b683703058cdbcd4d911',43097274769:'29dcc775a6c413f9ff5852a510e81b54fd426465'}
 if target!='MATRIX_PREVIEW_WINDOW_PAUSED' or run.get('status')!='queued' or run.get('id') not in reviewed or run.get('head_sha')!=reviewed[run['id']] or jobs!=0 or check_runs!=0:
  raise RuntimeError('Source deployment is not covered by the verified target hold')
def assert_window(phase):
 window=json.loads((ROOT/'source-active-window.json').read_text());now=datetime.datetime.now(datetime.timezone.utc)
 # Safety shutdown must remain possible after the test deadline or GitHub outage.
 if phase in {'close','off'}:return window
 if now>=datetime.datetime.fromisoformat(window['deadline']):raise RuntimeError('Approved window expired; close/cleanup before further changes')
 if phase=='admission' and now>=datetime.datetime.fromisoformat(window['admissionCloseNoLaterThan']):raise RuntimeError('Admission deadline reached')
 if gh('repos/HamedMP/matrix-os/actions/workflows/290088254')['state']!='disabled_manually':raise RuntimeError('Source deployment workflow is not paused')
 if phase=='admission':
  setup=json.loads((ROOT/'source-maintenance-setup-receipt.json').read_text())
  if not setup.get('normalUserSetupPassed') or setup.get('admissionEnabled') is not False:raise RuntimeError('Normal closed-admission setup proof is required')
  hold=json.loads((ROOT/'source-deployment-target-hold.applied.json').read_text())
  target=gh('repos/HamedMP/matrix-os/environments/production/variables/CLOUD_RUN_SERVICE')['value']
  if not hold.get('applied') or hold.get('heldValue')!=target or hold.get('invalidServiceIdProof',{}).get('validationStatus')!=400:raise RuntimeError('Source-only target hold is not verified')
  active={}
  for status in ['queued','in_progress','waiting','requested','pending']:
   page=gh('repos/HamedMP/matrix-os/actions/workflows/290088254/runs?status='+status+'&per_page=100')
   rows=page.get('workflow_runs',[])
   if page.get('total_count')!=len(rows) or len(rows)>100:raise RuntimeError('Incomplete Source queue observation')
   for run in rows:active[run['id']]=run
  for run in active.values():
   jobs=gh('repos/HamedMP/matrix-os/actions/runs/'+str(run['id'])+'/jobs?per_page=100')
   suite=gh('repos/HamedMP/matrix-os/check-suites/'+str(run['check_suite_id']))
   assert_held_stale_run(run,jobs.get('total_count'),suite.get('latest_check_runs_count'),target)

 return window

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('phase',choices=['maintenance','admission','close','off']);parser.add_argument('--apply',action='store_true');args=parser.parse_args();window=assert_window(args.phase)
 if args.phase=='off' and not window.get('cleanupProven'):raise RuntimeError('Prove exact cleanup before stopping maintenance')
 config=json.loads((ROOT/'source-env.disabled.json').read_text());cloud=reader.base.Cloud();order=['matrix-platform-worker','matrix-platform']
 before={n:cloud.request(reader.base.PREFIX+n) for n in order};patches={n:build_phase_patch(before[n],config,args.phase) for n in order}
 for n in order:cloud.validate(patches[n]);print('Source phase validated: '+args.phase+' '+n,flush=True)
 receipt={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase':args.phase,'applied':args.apply,'deadline':window['deadline'],'services':{}}
 path=ROOT/('source-phase-'+args.phase+('-applied.json' if args.apply else '-validation.json'))
 def save():path.write_text(json.dumps(receipt,indent=2)+'\n');path.chmod(0o600)
 save()
 for n in order:
  if cloud.request(reader.base.PREFIX+n)['etag']!=before[n]['etag']:raise RuntimeError('Source changed concurrently; refresh rather than overwrite')
  if args.apply:
   cloud.wait(cloud.request(reader.base.PREFIX+n,patches[n]));print('Source phase applied: '+args.phase+' '+n,flush=True)
  after=cloud.request(reader.base.PREFIX+n)
  if args.apply:
   actual=copy.deepcopy(after['template']['containers']);wanted=copy.deepcopy(patches[n]['template']['containers'])
   for group in [actual,wanted]:
    for c in group:c['env']=sorted(c['env'],key=lambda x:x['name'])
   if actual!=wanted:raise RuntimeError('Source container readback differs')
   traffic=[x for x in after.get('trafficStatuses',[]) if x.get('percent',0)>0]
   if len(traffic)!=1 or traffic[0].get('percent')!=100 or traffic[0].get('revision')!=after['latestReadyRevision'].split('/')[-1] or after.get('reconciling') or after['terminalCondition']['state']!='CONDITION_SUCCEEDED':raise RuntimeError('Source revision is not ready/solely serving')
  receipt['services'][n]={'priorRevision':before[n].get('latestReadyRevision'),'revision':after.get('latestReadyRevision'),'ready':True,'flags':{x['name']:x['value'] for x in after['template']['containers'][0]['env'] if x['name'] in FLAGS}};save()
 if args.apply:
  window.update(state=args.phase+'-applied',maintenanceEnabled=args.phase!='off',admissionEnabled=args.phase=='admission');p=ROOT/'source-active-window.json';p.write_text(json.dumps(window,indent=2)+'\n');p.chmod(0o600)
 print(json.dumps(receipt))
if __name__=='__main__':
 try:main()
 except (RuntimeError,ValueError,KeyError,TypeError,OSError,subprocess.SubprocessError) as e:
  print('Source phase stopped: '+str(e));raise SystemExit(1)
