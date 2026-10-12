import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {writeSshPrivateKey} from '../../scripts/ci/dedicated-ssh.mjs';

const execute=promisify(execFile);
const options={timeout:10_000,maxBuffer:16_384};
let directory:string,key:string,publicKey:string;
beforeAll(async()=>{
 directory=await mkdtemp(join(tmpdir(),'matrix-ci-key-test-'));
 const path=join(directory,'generated');
 await execute('ssh-keygen',['-q','-t','ed25519','-N','','-C','ci-test','-f',path],options);
 key=await readFile(path,'utf8');
 publicKey=(await execute('ssh-keygen',['-y','-f',path],options)).stdout;
});
afterAll(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});

describe('actual OpenSSH credential serialization',()=>{
 it('reproduces rejection of a secret whose final newline was trimmed',async()=>{
  const path=join(directory,'unserialized');
  await writeFile(path,key.trimEnd(),{mode:0o600,flag:'wx'});
  await expect(execute('ssh-keygen',['-y','-f',path],options)).rejects.toMatchObject({code:255});
 });
 it.each(['trimmed','intact'])('writes a parseable %s secret with the same public identity',async kind=>{
  const path=join(directory,kind);
  await writeSshPrivateKey(path,kind==='trimmed'?key.trimEnd():key);
  expect((await execute('ssh-keygen',['-y','-f',path],options)).stdout).toBe(publicKey);
  expect((await stat(path)).mode&0o777).toBe(0o600);
  expect(await readFile(path,'utf8')).toBe(key);
 });
 it('refuses to overwrite an existing key file',async()=>{
  const path=join(directory,'exclusive');await writeSshPrivateKey(path,key);
  await expect(writeSshPrivateKey(path,key)).rejects.toMatchObject({code:'EEXIST'});
 });
 it.each(['','x'.repeat(16_385)])('rejects invalid bounded input before creating a file',async value=>{
  const path=join(directory,'invalid');
  await expect(writeSshPrivateKey(path,value)).rejects.toThrow('Pinned SSH connection is not configured');
  await expect(stat(path)).rejects.toMatchObject({code:'ENOENT'});
 });
});
