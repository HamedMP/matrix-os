import {describe,it,expect} from 'vitest';import {mkdtemp,mkdir,writeFile,readFile,rm,rename} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {publishCommunityInstall} from '../../../packages/gateway/src/app-store/install-publication.js';
import {installedMatches,recoverInstallPublications} from '../../../packages/gateway/src/app-store/install-recovery.js';
import {readStoreProvenance,writeStoreProvenance} from '../../../packages/gateway/src/app-store/provenance.js';
import {encodeAppBundle,bundleDigest} from '../../../packages/contracts/src/app-store-bundle.js';
import {deriveAppStoreCapabilities} from '../../../packages/contracts/src/app-store.js';
const id=(n:number)=>`e53000b2-83ab-4c64-b8fc-ff176d733cb${n}`;
describe.skipIf(process.platform!=='linux')('actual filesystem install recovery',()=>{
 it('verifies published bytes, preserves edits, reinstalls after deletion, restores interrupted publication',async()=>{
 const home=await mkdtemp(join(tmpdir(),'matrix-store-recovery-'));await mkdir(join(home,'apps'),{mode:0o700});const manifest={name:'Fixture',description:'Recovery fixture',slug:'fixture',runtime:'vite',version:'1.0.0',permissions:[]};
 const source=new Map([['matrix.json',Buffer.from(JSON.stringify(manifest))],['package.json',Buffer.from('{}')],['pnpm-lock.yaml',Buffer.from('lock')],['index.html',Buffer.from('source')]]);const dist=new Map([['index.html',Buffer.from('built')]]);
 const options={homePath:home,jobId:id(0),listingSlug:'fixture',source,dist,distSha256:bundleDigest(encodeAppBundle('dist',dist)),toolchain:{nodeVersion:'v24.14.1',pnpmVersion:'10.33.4',policyDigest:'0'.repeat(64)},grant:{versionId:id(1),version:'1.0.0',manifest,capabilities:deriveAppStoreCapabilities(manifest as never),source:{sha256:bundleDigest(encodeAppBundle('source',source))}}};
 try{const installed=await publishCommunityInstall(options as never);expect(await installedMatches(home,installed)).toBe(true);
 await writeFile(join(home,'apps/fixture/index.html'),'owner edit');await expect(publishCommunityInstall({...options,jobId:id(2)} as never)).rejects.toMatchObject({code:'conflict'});expect(await readFile(join(home,'apps/fixture/index.html'),'utf8')).toBe('owner edit');
 await rm(join(home,'apps/fixture'),{recursive:true});const reinstalled=await publishCommunityInstall({...options,jobId:id(3)} as never);expect(await installedMatches(home,reinstalled)).toBe(true);
 const stage=join(home,`data/app-store/install-stages/${id(4)}`);await mkdir(stage,{mode:0o700});await rename(join(home,'apps/fixture'),join(stage,'backup'));const interrupted={...reinstalled,versionId:id(5),version:'2.0.0',installedSourceSha256:'1'.repeat(64)};
 await writeFile(join(stage,'journal.json'),JSON.stringify({record:interrupted,previous:reinstalled}));await writeStoreProvenance(home,{version:1,installs:[interrupted]});await recoverInstallPublications(home);
 expect(await installedMatches(home,reinstalled)).toBe(true);expect((await readStoreProvenance(home)).installs[0].versionId).toBe(reinstalled.versionId);
 await writeFile(join(home,'apps/fixture/dist/index.html'),'tampered');expect(await installedMatches(home,reinstalled)).toBe(false);
 }finally{await rm(home,{recursive:true,force:true});}
 });
});
