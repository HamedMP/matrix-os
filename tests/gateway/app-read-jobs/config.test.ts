import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateAppReadJobConfig } from "../../../packages/gateway/src/app-read-jobs/config.js";
const job={id:"brief",app:"developer-briefing",recipe:"developer-briefing-v1",enabled:false,intervalMs:900000,sources:[{id:"repo",service:"github",connectionId:"fixed",label:"Work",params:{repo:"owner/repo"}}]};
let home:string;
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),"app-read-job-config-"));await mkdir(join(home,"system"));await writeFile(join(home,"system/app-read-jobs.json"),JSON.stringify({jobs:[job]}));});
afterEach(async()=>{await rm(home,{recursive:true,force:true});});
describe("owner read job configuration",()=>{
 it("never removes an old lock that another writer may currently own",async()=>{
  const lock=join(home,"system/app-read-jobs.json.lock");
  await writeFile(lock,"existing owner");
  const old=new Date(Date.now()-180000);await utimes(lock,old,old);
  await expect(updateAppReadJobConfig(home,job.app,job.id,{enabled:true})).rejects.toMatchObject({code:"EEXIST"});
  expect(await readFile(lock,"utf8")).toBe("existing owner");
  expect(JSON.parse(await readFile(join(home,"system/app-read-jobs.json"),"utf8")).jobs[0].enabled).toBe(false);
 });
 it("changes schedule metadata atomically while retaining exact source scope",async()=>{
  await updateAppReadJobConfig(home,job.app,job.id,{enabled:true,intervalMs:1800000,summary:{enabled:true}});
  const config=JSON.parse(await readFile(join(home,"system/app-read-jobs.json"),"utf8"));
  expect(config.jobs[0]).toMatchObject({enabled:true,intervalMs:1800000,sources:job.sources,summary:{timezone:"Asia/Shanghai",dailyHour:9}});
 });
 it("rejects source or executable widening, missingjobs and unsafe intervals",async()=>{
  for(const settings of [{sources:[]},{intervalMs:1000},{ownerId:"foreign"}]) await expect(updateAppReadJobConfig(home,job.app,job.id,settings as any)).rejects.toThrow();
  await expect(updateAppReadJobConfig(home,job.app,"missing",{enabled:true})).rejects.toThrow();
  expect(JSON.parse(await readFile(join(home,"system/app-read-jobs.json"),"utf8")).jobs[0]).toEqual(job);
 });
});
