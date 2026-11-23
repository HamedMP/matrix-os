import { readFile } from 'node:fs/promises';
import { expect,it } from 'vitest';
import { parse } from 'yaml';
import { gunzipSync } from 'node:zlib';
import { preparePreviewBootstrapDiagnostics } from '../../scripts/task-preview-bootstrap-diagnostics.mjs';
import { renderCloudInitTemplate } from '../../packages/platform/src/customer-vps-cloud-init.js';
const key=Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,7)]).toString('base64');
const guard={provisioningClass:'preview',handle:'pr-3482',runtimeSlot:'pr-3482',ownerId:'user_diag_fixture',machineId:'11111111-2222-4333-8444-555555555555',attemptId:'a'.repeat(32),expiresAt:'2026-11-23T03:00:00.000Z',publicKey:`ssh-ed25519 ${key}`,now:new Date('2026-11-23T02:00:00.000Z')};
async function rendered(template?:string,overrides:Record<string,string>={}){
 template ??= await readFile('distro/customer-vps/cloud-init.yaml','utf8');
 const input={machineId:guard.machineId,clerkUserId:guard.ownerId,handle:guard.handle,runtimeSlot:guard.runtimeSlot,previewRuntimeEnv:'MATRIX_PREVIEW_RUNTIME=true',registrationToken:'r'.repeat(64),postgresPassword:'p'.repeat(48),platformVerificationToken:'v'.repeat(64),syncRuntimeToken:'s'.repeat(64),fundedAiRuntimeToken:'f'.repeat(64),platformSpeechRuntimeToken:'t'.repeat(64),registrationTokenExpiresAt:'2026-11-23T04:00:00Z',hostBundleUrl:'https://preview.invalid/bundle.tar.gz'};
 return renderCloudInitTemplate(template,{...input,...overrides} as never).replace(/\{\{\w+\}\}/g,'fixture');
}
it('injects a non-deferred forced collector while preserving startup bytes and provider limit',async()=>{
 const original=await rendered(),before=parse(original);
 const result=await preparePreviewBootstrapDiagnostics(original,guard),after=parse(result);
 expect(after.runcmd.map((entry:any)=>{
  if(typeof entry!=='string'||!entry.startsWith('. /usr/local/lib/matrix-preview-diag/runcmd-'))return entry;
  const file=after.write_files.find((item:any)=>`. ${item.path}`===entry);
  expect(file).toMatchObject({owner:'root:root',permissions:'0600',defer:false,encoding:'gz+b64'});
  return gunzipSync(Buffer.from(file.content,'base64')).toString();
 })).toEqual(before.runcmd);
 expect(after.write_files[0]).toMatchObject({path:'/usr/local/sbin/matrix-preview-bootstrap-diag',owner:'root:root',permissions:'0700',defer:false});
 const user=after.users.find((item:any)=>item.name==='matrix-preview-diag');
 expect(user.lock_passwd).toBe(true);expect(user.ssh_authorized_keys[0]).toContain('no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc,command=');
 for(const entry of before.write_files){const actual=after.write_files.find((item:any)=>item.path===entry.path);const content=actual.encoding==='gz+b64'?gunzipSync(Buffer.from(actual.content,'base64')).toString():actual.content;expect(content).toBe(entry.content);}
 expect(Buffer.byteLength(result)).toBeLessThanOrEqual(32768);
});
it.each([{...guard,provisioningClass:'customer'},{...guard,runtimeSlot:'primary'},{...guard,handle:'another'},{...guard,ownerId:'user_other'},{...guard,publicKey:'command="sh" ssh-ed25519 bad'},{...guard,expiresAt:'2026-11-24T02:00:00Z'}])('rejects wrong preview scope, identity, key or expiry before producing user-data',async options=>{
 await expect(preparePreviewBootstrapDiagnostics(await rendered(),options)).rejects.toThrow();
});

import { mkdtemp,writeFile,chmod,lstat,readdir,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync,spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach } from 'vitest';
import { collectPreviewBootstrapDiagnostics,savePreviewDiagnostic } from '../../scripts/task-preview-bootstrap-diagnostics.mjs';
const folders:string[]=[];afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function folder(){const path=await mkdtemp(join(tmpdir(),'matrix-preview-diag-test-'));folders.push(path);await chmod(path,0o700);return path;}
const report=()=>({version:1,attemptId:guard.attemptId,identityMatched:true,identityStage:'host_env',identity:{ownerId:guard.ownerId,machineId:guard.machineId,handle:guard.handle,runtimeSlot:guard.runtimeSlot,provisioningClass:guard.provisioningClass},sections:['cloud-init-status','bootstrap-log','service-state','service-journal'].map(name=>({name,status:'ok',exitCode:0,output:'fixture'}))});
function python(code:string,input:unknown){
 const path=new URL('../../scripts/task-preview-bootstrap-collector.py',import.meta.url).pathname;
 const result=spawnSync('python3',['-I','-c',`import importlib.util,json,sys,os,time\nspec=importlib.util.spec_from_file_location('collector',${JSON.stringify(path)});m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n${code}`],{input:JSON.stringify(input),encoding:'utf8',timeout:5000,maxBuffer:128*1024});
 expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout);
}
it('runs actual collector logic against fixed command fixtures, preserves failure context and removes secrets',()=>{
 const value=python(`data=json.load(sys.stdin)\ng=data['guard'];secrets=m.secret_values(data['raws']);calls=[]\ndef runner(argv,**limits):\n calls.append({'argv':argv,**limits})\n if argv[0].endswith('cloud-init'):return ('ok',0,json.dumps({'status':'error','stage':'final','user_data':'do-not-display'}))\n if argv[0].endswith('tail'):return ('ok',0,'runcmd exit 1: EACCES /home/matrix/home/system/test\\n'+data['secret']+'\\nMATRIX_AUTH_TOKEN=unlisted-value')\n if argv[0].endswith('journalctl'):return ('ok',0,json.dumps({'_SYSTEMD_UNIT':'matrix-terminal-runtime.service','MESSAGE':'Permission denied /home/matrix/home/cache'})+'\\n'+json.dumps({'_SYSTEMD_UNIT':'foreign.service','MESSAGE':'PRIVATE_OWNER_CONTENT'}))\n return ('failed',3,'Id=matrix-terminal-runtime.service\\nActiveState=failed\\nExecMainStatus=1')\nr=m.collect(g,data['host'],secrets,runner);print(json.dumps({'result':r,'calls':calls}))`,{guard:{...guard,issuedAt:1795399200,expiresAt:1795402800},host:`MATRIX_HANDLE=${guard.handle}\nMATRIX_RUNTIME_SLOT=${guard.runtimeSlot}\nMATRIX_MACHINE_ID=${guard.machineId}\nMATRIX_CLERK_USER_ID=${guard.ownerId}\nMATRIX_PREVIEW_RUNTIME=true`,raws:['MATRIX_AUTH_TOKEN=actual-fixture-secret-value'],secret:'actual-fixture-secret-value'});
 expect(value.result.sections).toHaveLength(4);expect(JSON.stringify(value)).not.toContain('actual-fixture-secret-value');expect(JSON.stringify(value)).not.toContain('unlisted-value');expect(JSON.stringify(value)).not.toContain('/home/matrix/home');expect(JSON.stringify(value)).not.toContain('PRIVATE_OWNER_CONTENT');expect(JSON.stringify(value)).not.toContain('do-not-display');expect(JSON.stringify(value)).toContain('EACCES');expect(JSON.stringify(value)).toContain('Permission denied');
 expect(value.calls).toHaveLength(4);expect(value.calls[1].argv).toEqual(['/usr/bin/tail','--bytes=32768','/var/log/cloud-init-output.log']);expect(value.calls.every((call:any)=>call.timeout===2&&call.limit===65536)).toBe(true);
});
it('bounds actual child output and kills a stalled child at the collector timeout',()=>{
 const value=python(`a=m.run_bounded([sys.executable,'-c','print("x"*200000)'],timeout=1,limit=4096)\nb=m.run_bounded([sys.executable,'-c','import time;time.sleep(30)'],timeout=0.05,limit=4096)\nprint(json.dumps({'status':a[0],'bytes':len(a[2].encode()),'timeout':b[0]}))`,{});
 expect(value).toEqual({status:'truncated',bytes:4096,timeout:'timeout'});
});
it('writes only0600 private identity-bound reports and caps retained artifacts without following symlinks',async()=>{
 const dir=await folder(),attempt=report();
 for(let i=0;i<10;i++)await savePreviewDiagnostic(dir,guard,JSON.stringify(attempt),Date.now()+i);
 const entries=(await readdir(dir)).filter(name=>name.endsWith('.json'));expect(entries).toHaveLength(8);
 expect((await lstat(join(dir,entries[0]!))).mode&0o777).toBe(0o600);
 const elsewhere=join(dir,'preserve.txt');await writeFile(elsewhere,'preserve');await symlink(elsewhere,join(dir,`matrix-preview-diag-${'b'.repeat(32)}-1000000000000.json`));
 await savePreviewDiagnostic(dir,guard,JSON.stringify(attempt),Date.now()+20);expect(await readFile(elsewhere,'utf8')).toBe('preserve');
 await expect(savePreviewDiagnostic(dir,{...guard,machineId:'wrong'},JSON.stringify(attempt))).rejects.toThrow('identity');
 await expect(savePreviewDiagnostic(dir,guard,JSON.stringify({...attempt,env:{TOKEN:'secret'}}))).rejects.toThrow('identity');
 await expect(savePreviewDiagnostic(dir,guard,'x'.repeat(100000))).rejects.toThrow('Bounded');
});
it('captures only pinned forced-command SSH, bounds timeout and never invokes a production shell command',async()=>{
 const dir=await folder(),keyPath=join(dir,'ephemeral'),hosts=join(dir,'known_hosts');await writeFile(keyPath,'fixture',{mode:0o600});await writeFile(hosts,'fixture',{mode:0o600});
 const calls:any[]=[];
 const stub=(command:string,args:string[],options:object)=>{calls.push({command,args});return spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(report()))})`],options);};
 const path=await collectPreviewBootstrapDiagnostics({...guard,host:'8.8.8.8',privateKeyPath:keyPath,knownHostsPath:hosts,outputDirectory:join(dir,'result'),spawnProcess:stub});
 expect((await lstat(path)).mode&0o777).toBe(0o600);expect(calls[0].command).toBe('ssh');expect(calls[0].args.at(-1)).toBe('matrix-preview-diag@8.8.8.8');expect(calls[0].args).toContain('StrictHostKeyChecking=yes');expect(calls[0].args).not.toContain('sh');
 const stalled=(_command:string,_args:string[],options:object)=>spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],options);
 await expect(collectPreviewBootstrapDiagnostics({...guard,host:'8.8.8.8',privateKeyPath:keyPath,knownHostsPath:hosts,outputDirectory:join(dir,'result'),spawnProcess:stalled,timeoutMs:50})).rejects.toThrow('timed out');
 await expect(collectPreviewBootstrapDiagnostics({...guard,handle:'production',host:'8.8.8.8',privateKeyPath:keyPath,knownHostsPath:hosts,outputDirectory:join(dir,'result'),spawnProcess:stub})).rejects.toThrow('Preview');expect(calls).toHaveLength(1);
});
it('caps sanitized UTF8 section output, not only Python character count',()=>{
 const value=python(`text=m.clean_text(('文'*700+'\\n')*80,[])\nprint(json.dumps({'bytes':len(text.encode())}))`,{});
 expect(value.bytes).toBeLessThanOrEqual(12288);
});
it('validates guest guard expiry and symlinks without requiring a registered runtime',async()=>{
 const dir=await folder(),file=join(dir,'guard.json');
 const object={...guard,issuedAt:1795399200,expiresAt:1795402800};await writeFile(file,JSON.stringify(object),{mode:0o600});
 const result=python(`data=json.load(sys.stdin);g=m.load_guard(data['path'],now=1795399300,owner=os.getuid())\nerrors=[]\nfor stamp in (1795399100,1795402800):\n try:m.load_guard(data['path'],now=stamp,owner=os.getuid())\n except ValueError:errors.append(True)\nprint(json.dumps({'missingStage':m.identity_stage(g,None),'expired':len(errors)}))`,{path:file});
 expect(result).toEqual({missingStage:'rendered_guard_only',expired:2});
 await symlink(file,join(dir,'link'));const linked=python(`data=json.load(sys.stdin)\ntry:m.load_guard(data['path'],now=1795399300,owner=os.getuid());denied=False\nexcept OSError:denied=True\nprint(json.dumps({'denied':denied}))`,{path:join(dir,'link')});expect(linked.denied).toBe(true);
});

it('rejects oversized SSH output without saving a partial artifact',async()=>{
 const dir=await folder(),keyPath=join(dir,'ephemeral'),hosts=join(dir,'known_hosts');await writeFile(keyPath,'fixture',{mode:0o600});await writeFile(hosts,'fixture',{mode:0o600});
 const noisy=(_command:string,_args:string[],options:object)=>spawn(process.execPath,['-e',`process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000)`],options);
 await expect(collectPreviewBootstrapDiagnostics({...guard,host:'8.8.8.8',privateKeyPath:keyPath,knownHostsPath:hosts,outputDirectory:join(dir,'result'),spawnProcess:noisy})).rejects.toThrow('cap');
 expect((await readdir(dir)).includes('result')).toBe(false);
});

it('fits a wide rendered config by preserving large runcmd scripts in compressed root files',async()=>{
 const config=parse(await rendered());
 // Synthetic high-entropy config values exercise rendered secret/URL width, never real credentials.
 const wide=randomBytes(6000).toString('base64');
 config.write_files.push({path:'/opt/matrix/env/fixture-width.env',owner:'root:root',permissions:'0600',content:`FIXTURE_TOKEN=${wide}\n`});
 const original='#cloud-config\n'+(await import('yaml')).stringify(config,{lineWidth:0});
 const result=await preparePreviewBootstrapDiagnostics(original,guard),after=parse(result);
 expect(Buffer.byteLength(result)).toBeLessThanOrEqual(32768);
 expect(after.runcmd[2]).toBe('. /usr/local/lib/matrix-preview-diag/runcmd-2.sh');
 const file=after.write_files.find((item:any)=>item.path==='/usr/local/lib/matrix-preview-diag/runcmd-2.sh');
 expect(gunzipSync(Buffer.from(file.content,'base64')).toString()).toBe(config.runcmd[2]);
});
it('dot-sourced scripts retain variables, shell options, order and startup failure in the original shell',async()=>{
 const dir=await folder(),config=parse(await rendered());
 config.runcmd=[`set -eu\nfixture_value=kept\n${'# padding\n'.repeat(100)}`,`printf '%s\n' "$fixture_value"\n${'# padding\n'.repeat(100)}`,`false\nprintf 'MUST_NOT_RUN'\n${'# padding\n'.repeat(100)}`,'printf AFTER_FAILURE'];
 const result=parse(await preparePreviewBootstrapDiagnostics('#cloud-config\n'+(await import('yaml')).stringify(config,{lineWidth:0}),guard));
 const commands=[];
 for(const command of result.runcmd){
  const source=result.write_files.find((file:any)=>`. ${file.path}`===command);
  if(!source){commands.push(command);continue;}
  const path=join(dir,source.path.split('/').at(-1));
  await writeFile(path,gunzipSync(Buffer.from(source.content,'base64')),{mode:0o600});
  commands.push(`. '${path}'`);
 }
 const before=spawnSync('/bin/sh',['-c',config.runcmd.join('\n')],{encoding:'utf8'});
 const after=spawnSync('/bin/sh',['-c',commands.join('\n')],{encoding:'utf8'});
 expect(after.status).toBe(1);expect(after.stdout).toBe('kept\n');expect(after.stdout).toBe(before.stdout);expect(after.status).toBe(before.status);
});

it('fits the actual tracked creation template with wide synthetic tokens and URLs while preserving scripts',async()=>{
 const tracked=spawnSync('git',['show','acd63981dcacb7d30a1f42f7814c1887254929d2:distro/customer-vps/cloud-init.yaml'],{encoding:'utf8',maxBuffer:256*1024});
 expect(tracked.status,tracked.stderr).toBe(0);
 const overrides:Record<string,string>={supportPublicKey:`ssh-ed25519 ${Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,9)]).toString('base64')}`};
 for(const name of ['registrationToken','postgresPassword','platformVerificationToken','syncRuntimeToken','fundedAiRuntimeToken','platformSpeechRuntimeToken'])overrides[name]=randomBytes(512).toString('hex');
 for(const name of ['hostBundleUrl','platformRegisterUrl','platformInternalUrl','fundedAiRelayUrl'])overrides[name]='https://preview.invalid/'+randomBytes(name==='hostBundleUrl'?1000:128).toString('hex');
 const before=parse(await rendered(tracked.stdout,overrides));
 const result=await preparePreviewBootstrapDiagnostics('#cloud-config\n'+(await import('yaml')).stringify(before,{lineWidth:0}),guard),after=parse(result);
 expect(Buffer.byteLength(result)).toBeLessThanOrEqual(32768);
 for(let index=0;index<before.runcmd.length;index++){
  const command=before.runcmd[index],actual=after.runcmd[index];
  if(typeof command!=='string'||Buffer.byteLength(command)<=512){expect(actual).toEqual(command);continue;}
  const file=after.write_files.find((item:any)=>`. ${item.path}`===actual);
  expect(file).toMatchObject({owner:'root:root',permissions:'0600',defer:false,encoding:'gz+b64'});
  expect(gunzipSync(Buffer.from(file.content,'base64')).toString()).toBe(command);
 }
});

it('still rejects oversized synthetic user-data rather than dropping configuration or raising the provider cap',async()=>{
 const config=parse(await rendered());
 config.write_files.push({path:'/opt/matrix/env/oversized-fixture.env',owner:'root:root',permissions:'0600',content:`FIXTURE_TOKEN=${randomBytes(40000).toString('base64')}\n`});
 await expect(preparePreviewBootstrapDiagnostics('#cloud-config\n'+(await import('yaml')).stringify(config,{lineWidth:0}),guard)).rejects.toThrow('provider limit');
});

it('rejects reusing the diagnostic key anywhere in the original rendered template',async()=>{
 const original=await rendered();
 for(const occurrence of [`# support key ssh-ed25519 ${key} repair\n`,`# unrelated-looking ${key}\n`]){
  await expect(preparePreviewBootstrapDiagnostics(original+occurrence,guard)).rejects.toThrow('Diagnostic key already present');
 }
});

it('keeps the latest bootstrap lines and UTF8 bytes so apt noise cannot hide the final failure',()=>{
 const value=python(`data=json.load(sys.stdin)\ndef runner(argv,**limits):\n if argv[0].endswith('tail'):return ('ok',0,('Unpacking fixture '+('文'*80)+'\\n')*220+'FATAL final bootstrap EACCES /home/matrix/home/system')\n return ('ok',0,'{}')\nr=m.collect(data,None,[],runner);print(json.dumps(r['sections'][1]))`,{...guard,issuedAt:1795399200,expiresAt:1795402800});
 expect(value.output).toContain('FATAL final bootstrap EACCES [owner-path]');
 expect(Buffer.byteLength(value.output)).toBeLessThanOrEqual(12288);
 expect(value.output.split('\n').length).toBeLessThanOrEqual(160);
});
it('projects journal fields and requests newest first so verbose metadata cannot exhaust the cap before the failure',()=>{
 const value=python(`data=json.load(sys.stdin);calls=[]\ndef runner(argv,**limits):\n if not argv[0].endswith('journalctl'):return ('ok',0,'{}')\n calls.append(argv)\n rows=[{'_SYSTEMD_UNIT':'cloud-final.service','MESSAGE':'FATAL final cloud-final failure','VERBOSE_METADATA':'x'*70000}]+[{'_SYSTEMD_UNIT':'cloud-final.service','MESSAGE':'old apt noise'}]*119\n if '--reverse' not in argv:rows.reverse()\n if '--output-fields=MESSAGE,_SYSTEMD_UNIT' in argv:rows=[{k:v for k,v in row.items() if k in ('MESSAGE','_SYSTEMD_UNIT')} for row in rows]\n raw='\\n'.join(json.dumps(row) for row in rows)\n return ('truncated' if len(raw)>limits['limit'] else 'ok',-9 if len(raw)>limits['limit'] else 0,raw[:limits['limit']])\nr=m.collect(data,None,[],runner);print(json.dumps({'section':r['sections'][3],'argv':calls[0]}))`,{...guard,issuedAt:1795399200,expiresAt:1795402800});
 expect(value.argv).toContain('--output-fields=MESSAGE,_SYSTEMD_UNIT');expect(value.argv).toContain('--reverse');
 expect(value.section.status).toBe('ok');expect(value.section.output).toContain('FATAL final cloud-final failure');expect(value.section.output).not.toContain('VERBOSE_METADATA');
});
