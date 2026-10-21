import {mkdtemp,readFile,rm,readdir,symlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,it,expect} from 'vitest';
import {writeBrowserArtifactManifest} from '../../packages/gateway/src/shared-browser/artifact-manifest.js';
const homes:string[]=[];
afterEach(async()=>{await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
const artifact={documentId:'INV-1',path:'data/browser-artifacts/INV-1-'+'a'.repeat(64)+'.pdf',size:800,sha256:'a'.repeat(64),sourceUrl:'https://example.com/invoice.pdf',retrievedAt:'2026-10-14T08:00:00.000Z',original:true as const};
async function home(){const path=await mkdtemp(join(tmpdir(),'matrix-invoice-export-'));homes.push(path);return path;}
describe('verified browser collection provenance',()=>{
  it('atomically exports original download provenance with deduplication and explicit hash conflicts',async()=>{
    const root=await home();const collectionId='12345678-1234-1234-1234-123456789abc';
    const second={...artifact,documentId:'INV-2',sha256:'b'.repeat(64),path:artifact.path.replace('INV-1','INV-2').replace('a'.repeat(64),'b'.repeat(64))};
    const conflict={...artifact,sha256:'c'.repeat(64),path:artifact.path.replace('a'.repeat(64),'c'.repeat(64))};
    const path=await writeBrowserArtifactManifest(root,collectionId,[artifact,second,artifact,conflict]);
    const data=JSON.parse(await readFile(join(root,path),'utf8'));
    expect(data).toMatchObject({version:1,kind:'browser-original-collection',coverage:'downloads_only',downloadCount:4,uniqueOriginalCount:3,duplicateDownloadCount:1});
    expect(data.artifacts).toHaveLength(3);expect(data.conflicts).toEqual([{documentId:'INV-1',hashes:['a'.repeat(64),'c'.repeat(64)]}]);
    expect(data.artifacts[0]).toMatchObject(artifact);expect(data).not.toHaveProperty('complete');
    expect((await readdir(join(root,'data/browser-artifacts'))).filter(name=>name.startsWith('.manifest-'))).toEqual([]);
    await writeBrowserArtifactManifest(root,collectionId,[artifact]);
    expect(JSON.parse(await readFile(join(root,path),'utf8')).downloadCount).toBe(1);
  });
  it('rejects unsafe identifiers, over-cap exports and replaced/symlinked artifact parents',async()=>{
    const root=await home();await expect(writeBrowserArtifactManifest(root,'../escape',[artifact])).rejects.toThrow();
    await expect(writeBrowserArtifactManifest(root,'12345678-1234-1234-1234-123456789abc',Array(65).fill(artifact))).rejects.toThrow();
    const external=await home();await mkdir(join(root,'data'));await symlink(external,join(root,'data/browser-artifacts'));
    await expect(writeBrowserArtifactManifest(root,'12345678-1234-1234-1234-123456789abc',[artifact])).rejects.toThrow();
    expect(await readdir(external)).toEqual([]);
  });
  it('retains every source/document receipt even when multiple invoice IDs have identical original bytes',async()=>{
    const root=await home();const second={...artifact,documentId:'INV-2',path:artifact.path.replace('INV-1','INV-2'),sourceUrl:'https://example.com/other-invoice.pdf'};
    const path=await writeBrowserArtifactManifest(root,'12345678-1234-1234-1234-123456789abc',[artifact,second]);
    const data=JSON.parse(await readFile(join(root,path),'utf8'));
    expect(data.artifacts).toHaveLength(1);expect(data.receipts).toEqual([artifact,second]);
    expect(data.uniqueOriginalCount).toBe(1);expect(data.downloadCount).toBe(2);
  });
});
