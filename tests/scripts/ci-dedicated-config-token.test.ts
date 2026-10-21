import { generateKeyPairSync, verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { mintConfigurationToken, withConfigurationGithub, createConfigurationSession } from '../../scripts/ci/dedicated-config-token.mjs';
const repo={owner:'HamedMP',repo:'matrix-os'};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const key=privateKey.export({type:'pkcs8',format:'pem'}).toString();
function fixture(overrides={}){
 const masks:string[]=[];const calls:any[]=[];
 const request=vi.fn(async(route:string,args:any)=>{calls.push({route,args});return {data:route==='GET /app'?{id:777}:route.startsWith('POST')?{token:'fake-config-token',expires_at:new Date(Date.now()+3600000).toISOString(),permissions:{actions_variables:'read',metadata:'read'},repositories:[{id:42,full_name:'HamedMP/matrix-os'}],...overrides}:{}};});
 Object.assign(request,{endpoint:{DEFAULTS:{baseUrl:'https://api.github.com'}}});
 class Client{request=request;rest={actions:{listRepoVariables:vi.fn()}};constructor(readonly options:any){}}
 const github=new Client({auth:'actions'});
 return {github,request,masks,calls,options:{appId:777,installationId:888,repositoryId:42,privateKey:key,mask:(value:string)=>masks.push(value)}};
}
it('mints a repository-only Variables read token using a signed short-lived App JWT',async()=>{
 const f=fixture();expect(await mintConfigurationToken(f.github,repo,f.options)).toBe('fake-config-token');
 const call=f.calls.find(c=>c.route.startsWith('POST'));expect(call.args).toMatchObject({installation_id:888,repository_ids:[42],permissions:{actions_variables:'read'},request:{timeout:10000}});
 expect(f.masks).toContain('fake-config-token');const jwt=f.masks[0],parts=jwt.split('.');
 expect(verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),publicKey,Buffer.from(parts[2],'base64url'))).toBe(true);
 const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString());expect(payload.iss).toBe('777');expect(payload.exp-payload.iat).toBeLessThanOrEqual(600);
 expect(f.calls.every(c=>c.args.request.timeout===10000)).toBe(true);
});
it.each([{permissions:{actions_variables:'write'}},{permissions:{actions_variables:'read',checks:'write'}},{repositories:[{id:43,full_name:'Elsewhere/repo'}]},{repositories:[{id:42,full_name:'HamedMP/matrix-os'},{id:43,full_name:'Elsewhere/repo'}]},{expires_at:'bad'}])('rejects and revokes an overbroad or unbound issued token %j',async value=>{
 const f=fixture(value);await expect(mintConfigurationToken(f.github,repo,f.options)).rejects.toThrow(/configuration/i);
 expect(f.masks).toContain('fake-config-token');expect(f.calls.at(-1).route).toBe('DELETE /installation/token');
});
it('rejects mismatched App identity before minting',async()=>{
 const f=fixture();f.request.mockResolvedValueOnce({data:{id:999}} as any);await expect(mintConfigurationToken(f.github,repo,f.options)).rejects.toThrow(/configuration/i);expect(f.calls.some(c=>c.route.startsWith('POST'))).toBe(false);
});
it('sanitizes token API errors so JWTs and key material cannot enter action logs',async()=>{
 const f=fixture();f.request.mockRejectedValueOnce(new Error('sensitive-request-authorization'));await expect(mintConfigurationToken(f.github,repo,f.options)).rejects.toThrow('Configuration read token could not be authenticated');
});
it('routes only variable reads to the separate client while retaining live reads and Actions writes',async()=>{
 const list=vi.fn().mockResolvedValueOnce({data:{variables:['first']}}).mockResolvedValueOnce({data:{variables:['changed']}});
 const ordinary=vi.fn(),write=vi.fn(),checks=vi.fn();const github={rest:{actions:{listRepoVariables:ordinary,createWorkflowDispatch:write},checks:{create:checks}}};
 const bound=withConfigurationGithub(github,{rest:{actions:{listRepoVariables:list}}});
 expect(await bound.rest.actions.listRepoVariables({})).toEqual({data:{variables:['first']}});expect(await bound.rest.actions.listRepoVariables({})).toEqual({data:{variables:['changed']}});
 await bound.rest.actions.createWorkflowDispatch({});await bound.rest.checks.create({});expect(ordinary).not.toHaveBeenCalled();expect(write).toHaveBeenCalledOnce();expect(checks).toHaveBeenCalledOnce();
});

it('wires configuration credentials only into authenticated default-main jobs and always revokes them',async()=>{
 const {readFileSync}=await import('node:fs');const {parse}=await import('yaml');
 const workflow=parse(readFileSync('.github/workflows/ci-dedicated.yml','utf8'));
 const job=workflow.jobs.reconcile,mint=job.steps.find((s:any)=>s.id==='configuration-token');
 expect(mint.env.CONFIGURATION_PRIVATE_KEY).toBe('${{ secrets.MATRIX_CI_GATE_APP_PRIVATE_KEY }}');
 expect(mint.with.script).toContain('mintConfigurationToken');expect(mint.with.script).toContain('repositoryId:context.payload.repository.id');
 const revoke=job.steps.find((s:any)=>s.name==='Revoke configuration read token');expect(revoke.if).toContain('always()');expect(revoke.with.script).toContain('DELETE /installation/token');
 const consumers=job.steps.filter((s:any)=>s.env?.CONFIGURATION_TOKEN&&s.name!=='Revoke configuration read token');expect(consumers).toHaveLength(1);expect(consumers[0].with.script).toContain('withConfigurationGithub');
 expect(job.steps.indexOf(mint)).toBeGreaterThan(job.steps.findIndex((s:any)=>s.uses?.startsWith('actions/checkout@')));
 for(const name of ['Dispatch authenticated PR qualification lease','Settle source-head check']){
  const step=workflow.jobs.benchmark.steps.find((s:any)=>s.name===name);
  expect(step.env.CONFIGURATION_PRIVATE_KEY).toBe('${{ secrets.MATRIX_CI_GATE_APP_PRIVATE_KEY }}');
  expect(step.with.script).toContain('createConfigurationSession');expect(step.with.script).toContain('finally');expect(step.with.script).toContain('configuration.close()');
 }
 const settle=workflow.jobs.benchmark.steps.find((s:any)=>s.name==='Settle source-head check');expect(settle.with.script).toContain('verifyDedicatedLeaseGrant(configuration.github,context.repo');
 const gate=workflow.jobs.reconcile.steps.find((s:any)=>s.id==='gate-token');expect(Object.keys(gate.with).filter(k=>k.startsWith('permission-'))).toEqual(['permission-checks']);
 expect(readFileSync('.github/workflows/ci.yml','utf8')).not.toContain('CONFIGURATION_TOKEN');
});

it('refreshes expiring credentials before live reads and revokes each owned token',async()=>{
 const f=fixture();vi.useFakeTimers();try{
  const session=createConfigurationSession(f.github,repo,f.options);
  await session.github.rest.actions.listRepoVariables({});
  expect(f.calls.filter(c=>c.route.startsWith('POST'))).toHaveLength(1);
  vi.advanceTimersByTime(56*60*1000);await session.github.rest.actions.listRepoVariables({});
  expect(f.calls.filter(c=>c.route.startsWith('POST'))).toHaveLength(2);
  expect(f.calls.filter(c=>c.route==='DELETE /installation/token')).toHaveLength(1);
  await session.close();expect(f.calls.filter(c=>c.route==='DELETE /installation/token')).toHaveLength(2);
 }finally{vi.useRealTimers();}
});
it('does not reuse a previous credential after refresh authentication fails',async()=>{
 const f=fixture();vi.useFakeTimers();try{
  const session=createConfigurationSession(f.github,repo,f.options);await session.github.rest.actions.listRepoVariables({});
  vi.advanceTimersByTime(56*60*1000);f.request.mockRejectedValueOnce(new Error('private-auth-header'));
  await expect(session.github.rest.actions.listRepoVariables({})).rejects.toThrow('Configuration read token could not be authenticated');
  await session.close();expect(f.calls.at(-1).route).toBe('DELETE /installation/token');
 }finally{vi.useRealTimers();}
});
