import {mkdtemp,open,readFile,writeFile,lstat,rm,symlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,it,expect} from 'vitest';
import {MailObjectStore} from '../../packages/gateway/src/mail/objects.js';
const directories:string[]=[];
async function fixture(){const path=await mkdtemp(join(tmpdir(),'mail-repair-'));directories.push(path);const store=new MailObjectStore(path);const pinned={path,close:async()=>{},openFile:(name:string,flags:number)=>open(join(path,name),flags|constants.O_NOFOLLOW,0o600),readFile:(name:string)=>readFile(join(path,name))};Object.assign(store,{directory:async()=>pinned});return{path,store};}
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});});
describe('atomic retained-content repair',()=>{
 it('republishes verified bytes over a corrupted regular object without leaving stages',async()=>{const {path,store}=await fixture();const bytes=Buffer.from('Retained letter');const object=await store.put('a'.repeat(64),bytes);await writeFile(join(path,object.digest),'Corrupted');await expect(store.read(object)).rejects.toMatchObject({code:'integrity'});await expect(store.put(object.namespace,bytes)).resolves.toEqual(object);expect(await store.read(object)).toEqual(bytes);expect((await lstat(join(path,object.digest))).mode&0o777).toBe(0o600);});
 it('repairs an oversized corrupt leaf without reading it into memory',async()=>{const {path,store}=await fixture();const bytes=Buffer.from('Retained letter');const object=await store.put('a'.repeat(64),bytes);await writeFile(join(path,object.digest),Buffer.alloc(2*1024*1024+1));await expect(store.read(object)).rejects.toMatchObject({name:'MailContentIntegrityError'});await store.put(object.namespace,bytes);expect(await store.read(object)).toEqual(bytes);});
 it('refuses to repair symlinked content and leaves the outside inode untouched',async()=>{const {path,store}=await fixture();const bytes=Buffer.from('Retained letter');const object=await store.put('a'.repeat(64),bytes);await rm(join(path,object.digest));const outside=join(path,'outside');await writeFile(outside,'Outside content');await symlink(outside,join(path,object.digest));await expect(store.put(object.namespace,bytes)).rejects.toThrow();expect(await readFile(outside,'utf8')).toBe('Outside content');});
});
