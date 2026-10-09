import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
const sha='a'.repeat(40);
const version='v2026.09.30-pr2055-123-1-aaaaaaa';
const release={schemaVersion:1,kind:'matrix-os-host-bundle',channel:'none',version,gitCommit:sha};
function probe(options:{release?:object,marker?:string,symlink?:boolean,oversized?:boolean}={}){
 const dir=mkdtempSync(join(tmpdir(),'preview-installed-proof-'));
 try{
  mkdirSync(join(dir,'app'));
  writeFileSync(join(dir,'app','BUNDLE_VERSION'),options.marker??version);
  const text=options.oversized?' '.repeat(65537):JSON.stringify(options.release??release);
  if(options.symlink){writeFileSync(join(dir,'other.json'),text);symlinkSync(join(dir,'other.json'),join(dir,'release.json'));}
  else writeFileSync(join(dir,'release.json'),text);
  return spawnSync('python3',['-c','import runpy,sys,json; from pathlib import Path; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["installed_provenance"](Path(sys.argv[2]),"pr-2055",sys.argv[3],sys.argv[4])))','scripts/preview-release-provenance.py',dir,version,sha],{encoding:'utf8',timeout:5000});
 }finally{rmSync(dir,{recursive:true,force:true});}
}
describe('installed preview release provenance',()=>{
 it('proves the full installed commit and matching app marker for pinned deploys',()=>{
  const r=probe();expect(r.status,r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({...release,kind:'matrix-os-preview-runtime',handle:'pr-2055'});
 });
 it.each([
  ['stale release commit',{release:{...release,gitCommit:'b'.repeat(40)}}],
  ['different release version',{release:{...release,version:version+'old'}}],
  ['different active app marker',{marker:version+'old'}],
  ['production channel',{release:{...release,channel:'dev'}}],
  ['wrong metadata kind',{release:{...release,kind:'other'}}],
  ['symlink metadata',{symlink:true}],
  ['oversized metadata',{oversized:true}],
 ] as const)('rejects %s',(_label,options)=>{const r=probe(options);expect(r.status).not.toBe(0);expect(r.stdout).toBe('');});
});
