import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {parsePreparedPatches,fetchPreparedPatches} from '../../scripts/ci/runner/prepared-patches.mjs';
const bytes=Buffer.from('reviewed package patch\n');
const hash=createHash('sha256').update(bytes).digest('hex');
const lock=(path='patches/app-builder-lib@26.15.3.patch',digest=hash)=>`lockfileVersion: '9.0'\npatchedDependencies:\n  app-builder-lib@26.15.3:\n    hash: ${digest}\n    path: ${path}\nimporters:\n  .: {}\n`;
describe('bounded immutable prepared-image patches',()=>{
  it('parses only safe patch paths and exact SHA256 digest',()=>expect(parsePreparedPatches(lock())).toEqual([{path:'patches/app-builder-lib@26.15.3.patch',hash}]));
  it.each(['../outside.patch','patches/../../outside.patch','/etc/anything.patch','patches/a/b.patch','patches/a;id.patch','patches/.hidden.patch'])('rejects unsafe path %s',path=>expect(()=>parsePreparedPatches(lock(path))).toThrow());
  it.each(['abc','A'.repeat(64),'sha256-'+hash])('rejects malformed hash %s',digest=>expect(()=>parsePreparedPatches(lock(undefined,digest))).toThrow());
  it('bounds patch count and rejects unknown fields/duplicate paths',()=>{
    const many='patchedDependencies:\n'+Array.from({length:9},(_,i)=>`  dependency-${i}:\n    hash: ${hash}\n    path: patches/p-${i}.patch\n`).join('');
    expect(()=>parsePreparedPatches(many)).toThrow();
    expect(()=>parsePreparedPatches(lock().replace('importers:', '    extra: unexpected\nimporters:'))).toThrow();
    expect(()=>parsePreparedPatches(lock().replace('importers:', `  other:\n    hash: ${hash}\n    path: patches/app-builder-lib@26.15.3.patch\nimporters:`))).toThrow();
  });
  it('downloads from exact public SHA and verifies digest before exclusive write',async()=>{
    const dir=mkdtempSync(resolve(tmpdir(),'matrix-prepared-patch-'));
    try {
      const fetcher=async(url:string,options:RequestInit)=>{expect(url).toBe(`https://raw.githubusercontent.com/HamedMP/matrix-os/${'a'.repeat(40)}/patches/app-builder-lib@26.15.3.patch`);expect(options.signal).toBeInstanceOf(AbortSignal);return new Response(bytes);};
      await fetchPreparedPatches(lock(),'a'.repeat(40),dir,{fetch:fetcher});
      expect(readFileSync(resolve(dir,'patches/app-builder-lib@26.15.3.patch'))).toEqual(bytes);
      await expect(fetchPreparedPatches(lock(),'a'.repeat(40),dir,{fetch:fetcher})).rejects.toThrow();
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it.each(['hash','size','stream-size'])('rejects invalid downloaded %s',async kind=>{
    const dir=mkdtempSync(resolve(tmpdir(),'matrix-prepared-patch-'));
    try {await expect(fetchPreparedPatches(lock(),'a'.repeat(40),dir,{fetch:async()=>kind==='hash'?new Response('wrong'):kind==='stream-size'?new Response(new Uint8Array(2097153)):new Response(bytes,{headers:{'content-length':'2097153'}})})).rejects.toThrow();}
    finally{rmSync(dir,{recursive:true,force:true});}
  });
});
