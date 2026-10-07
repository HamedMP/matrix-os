import { mkdtemp, readFile, lstat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlanVault } from '../../desktop/src/main/chatgpt-plan/vault';
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
const safe={isEncryptionAvailable:()=>true,encryptString:(x:string)=>Buffer.from(x).reverse(),decryptString:(x:Buffer)=>Buffer.from(x).reverse().toString()};
describe('local owner protected subscription vault',()=>{
 it('persists stable device identity, isolates Matrix owners and encrypts atomic records with owner-only permissions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'matrix-plan-'));dirs.push(dir);const vault=createPlanVault({dir,safeStorage:safe});
  const first=await vault.load('owner-a');await vault.save('owner-a',first);const second=await vault.load('owner-a');expect(second.hostId).toBe(first.hostId);expect(second.devicePrivateKey).toBe(first.devicePrivateKey);
  expect((await vault.load('owner-b')).deviceId).not.toBe(first.deviceId);
  const names=await readdir(dir);expect(names.filter(x=>x.endsWith('.tmp'))).toEqual([]);const file=join(dir,names.find(x=>x.endsWith('.bin'))!);expect((await lstat(file)).mode&0o777).toBe(0o600);expect((await readFile(file)).toString()).not.toContain(first.devicePrivateKey);
 });
 it('refuses persistence when OS key custody is unavailable',async()=>{const dir=await mkdtemp(join(tmpdir(),'matrix-plan-'));dirs.push(dir);const vault=createPlanVault({dir,safeStorage:{...safe,isEncryptionAvailable:()=>false}});await expect(vault.load('owner')).rejects.toThrow();});
});
import { symlink, utimes, writeFile } from 'node:fs/promises';
it('removes only expired real temporary credential files at boot, preserving symlinks and recent writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'matrix-plan-'));dirs.push(dir);
 const prefix=`chatgpt-plan-${'a'.repeat(64)}.bin.`;
 const stale=join(dir,`${prefix}00000000-0000-4000-8000-000000000001.tmp`);
 const recent=join(dir,`${prefix}00000000-0000-4000-8000-000000000002.tmp`);
 const link=join(dir,`${prefix}00000000-0000-4000-8000-000000000003.tmp`);
 await writeFile(stale,'old');await writeFile(recent,'new');await symlink(stale,link);await utimes(stale,0,0);
 await createPlanVault({dir,safeStorage:safe}).cleanup();
 expect(await readdir(dir)).not.toContain(stale.split('/').at(-1));expect(await readdir(dir)).toContain(recent.split('/').at(-1));expect((await lstat(link)).isSymbolicLink()).toBe(true);
});
