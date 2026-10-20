import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('keeps the trusted runtime root sealed while developer-tool directories remain writable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'store-runtime-permissions-'));
 try{
  const runtime=join(root,'runtime');await mkdir(join(runtime,'bin'),{recursive:true});await mkdir(join(runtime,'lib','node_modules'),{recursive:true});
  const script=await readFile('scripts/install-server.sh','utf8');
  const fn=script.match(/prepare_runtime_permissions\(\) \{[\s\S]*?\n\}/)?.[0];expect(fn).toBeTruthy();
  const fixture=join(root,'check.sh');await writeFile(fixture,`set -e\nsection(){ :; }\nok(){ :; }\nwarn(){ :; }\nrun_required(){ shift; if [ "$1" = chown ]; then return; fi; "$@"; }\nMATRIX_INSTALL_LOG=/dev/null\n${fn!.replaceAll('/opt/matrix/runtime/node',runtime)}\nprepare_runtime_permissions\n`);
  execFileSync('bash',[fixture]);
  expect((await stat(runtime)).mode&0o7777).toBe(0o755);
  expect((await stat(join(runtime,'bin'))).mode&0o020).toBe(0o020);
  expect((await stat(join(runtime,'lib','node_modules'))).mode&0o020).toBe(0o020);
 }finally{await rm(root,{recursive:true,force:true});}
});
