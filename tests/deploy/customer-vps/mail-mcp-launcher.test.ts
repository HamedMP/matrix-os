import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import {expect,it} from 'vitest';
it('selects the separate mail capability and never falls back to custom or machine credentials',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'matrix-mail-launch-'));
 try{
  const server=join(directory,'server.cjs');await writeFile(server,'console.log(JSON.stringify({token:process.env.MATRIX_AGENT_INTEGRATIONS_TOKEN,host:process.env.MATRIX_AUTH_TOKEN,mail:process.env.MATRIX_AGENT_MAIL_TOKEN}));');
  const script=(await readFile('distro/customer-vps/host-bin/matrix-integrations-mcp','utf8')).replace('NODE_BIN="/opt/matrix/runtime/node/bin/node"',`NODE_BIN="${process.execPath}"`).replace('SERVER_PATH="/opt/matrix/app/packages/integrations-mcp/dist/cli.js"',`SERVER_PATH="${server}"`);
  const run=(mail?:string)=>spawnSync('bash',['-c',script,'fixture','--tool-surface=mail-read'],{encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH??'',MATRIX_AGENT_INTEGRATIONS_TOKEN:'a'.repeat(64),MATRIX_AUTH_TOKEN:'host-secret',...(mail===undefined?{}:{MATRIX_AGENT_MAIL_TOKEN:mail})}});
  const success=run('b'.repeat(64));expect(success.status).toBe(0);expect(JSON.parse(success.stdout)).toEqual({token:'b'.repeat(64)});
  for(const token of [undefined,'','wrong'])expect(run(token).status).toBe(3);
 }finally{await rm(directory,{recursive:true,force:true});}
});
