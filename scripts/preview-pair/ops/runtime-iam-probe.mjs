// Plan is injected by the matching Python runner; no inventory is embedded.

const marker = 'MATRIX_PAIR_IAM_PROBE';
async function read(response) {
  if (!response.ok) throw new Error('PermissionMetadataRequestFailed');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try { while(true) { const part=await reader.read();if(part.done)break;
    size+=part.value.length;if(size>32768)throw new Error('PermissionMetadataTooLarge');chunks.push(part.value);
  }} finally { await reader.cancel(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
async function metadata(path) {
  return read(await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/'+path,
    {headers:{'Metadata-Flavor':'Google'},redirect:'error',signal:AbortSignal.timeout(10000)}));
}
async function main() {
  const email=(await metadata('email')).trim();
  if(email!==plan.identity)throw new Error('UnexpectedProbeIdentity');
  const auth=JSON.parse(await metadata('token'));
  if(typeof auth.access_token!=='string'||auth.access_token.length>8192)throw new Error('InvalidMetadataIdentity');
  let token=auth.access_token;
  async function check(url,permissions) {
    const result=JSON.parse(await read(await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({permissions})})));
    const granted=result.permissions??[];
    if(!Array.isArray(granted)||granted.some(p=>typeof p!=='string'||!permissions.includes(p)))throw new Error('InvalidPermissionMetadata');
    return granted;
  }
  const approved=new Set(plan.approved);const secretResults=[];let next=0;
  async function worker() {
    while(next<plan.secretIds.length) {
      const name=plan.secretIds[next++];
      const permissions=await check('https://secretmanager.googleapis.com/v1/projects/matrix-os-1144/secrets/'+name+':testIamPermissions',
        ['secretmanager.versions.access','secretmanager.secrets.setIamPolicy']);
      secretResults.push({name,read:permissions.includes('secretmanager.versions.access'),mutatePolicy:permissions.includes('secretmanager.secrets.setIamPolicy')});
    }
  }
  await Promise.all(Array.from({length:4},worker));
  const sourcePermissions=await check('https://iam.googleapis.com/v1/projects/matrix-os-1144/serviceAccounts/matrix-platform-runner@matrix-os-1144.iam.gserviceaccount.com:testIamPermissions',
    ['iam.serviceAccounts.getAccessToken','iam.serviceAccounts.actAs','iam.serviceAccounts.setIamPolicy']);
  const sourceRunPermissions=await check('https://run.googleapis.com/v2/projects/matrix-os-1144/locations/europe-west3/services/matrix-platform:testIamPermissions',
    ['run.services.update','run.services.delete','run.services.setIamPolicy']);
  const projectPermissions=await check('https://cloudresourcemanager.googleapis.com/v1/projects/matrix-os-1144:testIamPermissions',
    ['resourcemanager.projects.setIamPolicy','iam.serviceAccounts.create','run.services.create','run.jobs.create']);
  const missing=secretResults.filter(x=>approved.has(x.name)&&!x.read).map(x=>x.name);
  const unexpected=secretResults.filter(x=>(!approved.has(x.name)&&x.read)||x.mutatePolicy);
  const success=missing.length===0&&unexpected.length===0&&sourcePermissions.length===0&&sourceRunPermissions.length===0&&projectPermissions.length===0;
  token=null;auth.access_token=null;
  console.log(JSON.stringify({marker,probeId:plan.probeId,principal:email,checkedAt:new Date().toISOString(),success,
    secretsChecked:secretResults.length,approvedSecretReadGrants:secretResults.filter(x=>approved.has(x.name)&&x.read).length,
    otherSecretReadDenials:secretResults.filter(x=>!approved.has(x.name)&&!x.read).length,
    missingApproved:missing,unexpected,sourcePermissions,sourceRunPermissions,projectPermissions,
    secretValueReads:0,iamChanges:0}));
  if(!success)process.exitCode=1;
}
main().catch(error=>{console.log(JSON.stringify({marker,probeId:plan.probeId,success:false,errorType:error.name,secretValueReads:0,iamChanges:0}));process.exitCode=1;});
