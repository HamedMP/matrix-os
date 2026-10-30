import {spawnSync} from "node:child_process";
import {mkdtemp,readFile,rm,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {expect,it} from "vitest";
const handle="cp-3022-11111111-1-a";
const base=`https://cp-11111111-g1-api---matrix-platform-preview-test.a.run.app/preview-pair-updates/${handle}`;
it.each([
 {name:"verified pair",handle,slot:handle,base,marker:"true",poll:false},
 {name:"ordinary Preview",handle:"pr-3022",slot:"pr-3022",base:"https://platform.example",marker:"true",poll:true},
 {name:"primary slot",handle,slot:"primary",base,marker:"true",poll:true},
 {name:"wrong generation",handle,slot:handle,base:base.replace("-g1-api","-g2-api"),marker:"true",poll:true},
 {name:"unmarked computer",handle,slot:handle,base,marker:"",poll:true},
])("passive updater preserves the correct policy for $name",async test=>{
 const directory=await mkdtemp(join(tmpdir(),"matrix-pair-update-"));
 try{
  const library=resolve("distro/customer-vps/host-bin/matrix-update-manifest");
  const source=(await readFile("distro/customer-vps/host-bin/matrix-sync-agent","utf8")).replace(/# BEGIN update manifest library loader[\s\S]*?# END update manifest library loader/,await readFile(library,"utf8"));
  const start=source.indexOf("check_for_update() {"),end=source.indexOf("\n}\n",start)+3;
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const result=spawnSync("bash",["-c",`set -euo pipefail
UPDATE_TRIGGER="$1/trigger"
UPDATE_MARKER="$1/marker"
POLL_LOG="$1/poll"
source "$2"
log() { :; }
manifest_url() { printf 'https://platform.example/channel.json'; }
curl() { printf called > "$POLL_LOG"; return 1; }
${source.slice(start,end)}
check_for_update`,"test",directory,library],{encoding:"utf8",timeout:10_000,env:{...process.env,MATRIX_HANDLE:test.handle,MATRIX_RUNTIME_SLOT:test.slot,MATRIX_UPDATE_MANIFEST_BASE_URL:test.base,MATRIX_PREVIEW_RUNTIME:test.marker}});
  expect(result.status,result.stderr).toBe(test.poll?1:0);
  let polled=true;try{await access(join(directory,"poll"));}catch(error:unknown){if(!(error instanceof Error)||!("code" in error)||error.code!=="ENOENT")throw error;polled=false;}
  expect(polled).toBe(test.poll);
 }finally{await rm(directory,{recursive:true,force:true});}
});
