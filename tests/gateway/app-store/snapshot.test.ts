import { describe,it,expect,beforeEach,afterEach } from 'vitest';
import { mkdtemp,mkdir,writeFile,symlink,rm } from 'node:fs/promises';import { tmpdir } from 'node:os';import {join} from 'node:path';
import {snapshotOwnerApp} from '../../../packages/gateway/src/app-store/snapshot.js';
let home:string;beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'store-snapshot-'));await mkdir(join(home,'apps/test'),{recursive:true});});afterEach(async()=>rm(home,{recursive:true,force:true}));
describe('private source snapshot',()=>{
 it.skipIf(process.platform!=='linux')('copies source bytes while excluding secrets and dependency outputs',async()=>{
  await writeFile(join(home,'apps/test/matrix.json'),'{}');await writeFile(join(home,'apps/test/index.html'),'original');await writeFile(join(home,'apps/test/.env'),'SECRET');await mkdir(join(home,'apps/test/dist'));await writeFile(join(home,'apps/test/dist/index.html'),'compiled');
  const files=await snapshotOwnerApp(home,'test');await writeFile(join(home,'apps/test/index.html'),'changed');
  expect(files.get('index.html')?.toString()).toBe('original');expect([...files.keys()]).not.toContain('.env');expect([...files.keys()]).not.toContain('dist/index.html');
 });
 it('refuses source symlinks and escaping slugs',async()=>{
  await symlink('/etc/passwd',join(home,'apps/test/secret.txt'));await expect(snapshotOwnerApp(home,'test')).rejects.toThrow();await expect(snapshotOwnerApp(home,'../test')).rejects.toThrow();
 });
});
