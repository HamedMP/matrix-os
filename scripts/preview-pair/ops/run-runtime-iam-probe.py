"""Run and remove only the labelled, bounded metadata probe. Never access secret values."""
import json,pathlib,subprocess,time,datetime
P=pathlib.Path(__file__).resolve().parent
plan=json.loads((P/'runtime-iam-probe-plan.json').read_text())
job=plan['job'];nonce=plan['probeId']
base=['--project=matrix-os-1144','--region=europe-west3']

def command(args,timeout=30,check=True):
    result=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
    if check and result.returncode:raise RuntimeError('Cloud metadata operation failed: '+' '.join(args[:4])+'; '+result.stderr[-1200:])
    return result

names=command(['gcloud','run','jobs','list',*base,'--format=value(metadata.name)']).stdout.splitlines()
if job in names:raise SystemExit('Unique probe job unexpectedly already exists; nothing was changed.')
code='const plan='+json.dumps(plan)+';\n'+(P/'runtime-iam-probe.mjs').read_text();delimiter='___MATRIX_PROBE_ARG___'
if delimiter in code:raise SystemExit('Unexpected argument delimiter')
args='^'+delimiter+'^--input-type=module'+delimiter+'-e'+delimiter+code
receipt={'job':job,'probeId':nonce,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'secretValueReads':0,'iamChanges':0,'cleanup':'pending'}
try:
    print('Deploying one temporary metadata-only task as the isolated preview identity.',flush=True)
    result=command(['gcloud','run','jobs','deploy',job,*base,'--image='+plan['image'],'--service-account='+plan['identity'],
        '--command=node','--args='+args,'--tasks=1','--parallelism=1','--max-retries=0','--task-timeout=180s','--cpu=1','--memory=512Mi',
        '--labels=issue=eng-418,purpose=preview-iam-probe,probe-id='+nonce,'--execute-now','--wait','--quiet','--format=json'],timeout=300,check=False)
    receipt['deploymentExitCode']=result.returncode
    if result.returncode:receipt['deploymentFailure']=result.stderr[-1800:]
    query='resource.type="cloud_run_job" AND resource.labels.job_name="'+job+'" AND jsonPayload.marker="MATRIX_PAIR_IAM_PROBE"'
    for attempt in range(8):
        rows=json.loads(command(['gcloud','logging','read',query,'--project=matrix-os-1144','--freshness=1h','--limit=20','--format=json']).stdout)
        matches=[x['jsonPayload'] for x in rows if x.get('jsonPayload',{}).get('probeId')==nonce]
        if matches:
            receipt['observation']=matches[0]
            break
        if result.returncode and attempt>=1:break
        time.sleep(5)
    if 'observation' not in receipt:receipt['observedSuccess']=False
    else:receipt['observedSuccess']=receipt['observation'].get('success') is True
finally:
    described=command(['gcloud','run','jobs','describe',job,*base,'--format=json'],check=False)
    if described.returncode==0:
        data=json.loads(described.stdout)
        if data.get('metadata',{}).get('labels',{}).get('probe-id')!=nonce:
            receipt['cleanup']='blocked: ownership label mismatch'
        else:
            deleted=command(['gcloud','run','jobs','delete',job,*base,'--quiet'],check=False)
            receipt['cleanup']='deleted' if deleted.returncode==0 else 'deletion pending'
    else:receipt['cleanup']='job not observed; verify absence before treating cleanup as proved'
    receipt['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (P/'runtime-iam-probe-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    (P/'runtime-iam-probe-receipt.json').chmod(0o600)
    observation=receipt.get('observation',{})
    print(json.dumps({'job':job,'success':receipt.get('observedSuccess',False),'secretsChecked':observation.get('secretsChecked'),
       'approvedReadGrants':observation.get('approvedSecretReadGrants'),'otherReadDenials':observation.get('otherSecretReadDenials'),
       'unexpectedPermissionCount':len(observation.get('unexpected',[]))+len(observation.get('sourcePermissions',[]))+len(observation.get('sourceRunPermissions',[]))+len(observation.get('projectPermissions',[])),
       'cleanup':receipt['cleanup'],'secretValueReads':0,'iamChanges':0}),flush=True)
if not receipt.get('observedSuccess'):raise SystemExit(1)
