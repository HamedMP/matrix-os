import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AppReadJobSettingsSchema, type AppReadJobSettings } from "@matrix-os/contracts";
import { ReadJobConfigSchema, ReadJobSchema } from "./types.js";

export const ReadJobSettingsSchema=AppReadJobSettingsSchema;
export type ReadJobSettings=AppReadJobSettings;
async function remove(path:string) {
  try{await unlink(path);}catch(error){if(!(error instanceof Error)||(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
/** Fixed owner-config file; callers can edit existing job configuration only; runner must authorize every candidate source before this writer. */
export async function updateAppReadJobConfig(homePath:string,app:string,jobId:string,settings:ReadJobSettings) {
  const patch=ReadJobSettingsSchema.parse(settings);
  const path=join(homePath,"system/app-read-jobs.json");
  const lockPath=`${path}.lock`;
  // Never reclaim by age: unlink-after-lstat can delete a new writer's lock.
  // A crash orphan is recovered explicitly after confirming all writers stopped.
  // Exclusive lock prevents two gateway processes from losing independent config edits.
  const lock=await open(lockPath,"wx",0o600);
  const temporary=`${path}.${randomUUID()}.tmp`;
  try{
    const info=await lstat(path);
    if(!info.isFile()||info.size>65536)throw new Error("Invalid app read job configuration");
    const config=ReadJobConfigSchema.parse(JSON.parse(await readFile(path,"utf8")));
    const index=config.jobs.findIndex(job=>job.app===app&&job.id===jobId);
    if(index<0)throw new Error("App read job configuration is unavailable");
    config.jobs[index]=ReadJobSchema.parse({...config.jobs[index],...patch});
    const file=await open(temporary,"wx",0o600);
    try{await file.writeFile(`${JSON.stringify(config,null,2)}\n`);await file.sync();}finally{await file.close();}
    await rename(temporary,path);
    return config.jobs[index]!;
  }finally{await lock.close();await remove(temporary);await remove(lockPath);}
}
