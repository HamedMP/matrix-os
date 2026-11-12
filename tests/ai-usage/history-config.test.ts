import {expect,it} from "vitest";
import {mkdtemp,mkdir,writeFile,symlink,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readUsageRootConfig} from "../../packages/gateway/src/ai-usage/history-config";
it("reads owner backup configuration while rejecting escaped and missing configured sources",async()=>{
 const home=await mkdtemp(join(tmpdir(),"usage-config-")),outside=await mkdtemp(join(tmpdir(),"usage-other-owner-"));
 try{
  expect(await readUsageRootConfig(home)).toEqual([]);await mkdir(join(home,"system"));await mkdir(join(home,"backups"));
  const file=join(home,"system","ai-usage-sources.json");
  const config=(path:string)=>JSON.stringify({version:1,sources:[{machine:"Mac",agent:"codex",path}]});
  await writeFile(file,config("backups"));expect((await readUsageRootConfig(home))[0].path).toBe(join(home,"backups"));
  await writeFile(file,config("missing"));await expect(readUsageRootConfig(home)).rejects.toThrow();
  await symlink(outside,join(home,"escape"));await writeFile(file,config("escape"));await expect(readUsageRootConfig(home)).rejects.toThrow();
 }finally{await rm(home,{recursive:true});await rm(outside,{recursive:true});}
});
