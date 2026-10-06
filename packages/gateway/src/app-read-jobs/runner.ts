import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectReadJob, type ReadRequest, type ScopedRead } from "./collector.js";
import { ReadJobConfigSchema, ReadJobSchema, contentHash, jobHash, summaryDue, type JsonValue, type ReadJob, type ReadJobClaim, type ReadJobSummary } from "./types.js";
import { ReadJobSettingsSchema, type ReadJobSettings } from "./config.js";
import type { AppReadJobStore } from "./store.js";

export class AppReadJobError extends Error {
  constructor(readonly code: "denied" | "invalid" | "unavailable" | "busy") { super("App read job is unavailable"); this.name="AppReadJobError"; }
}
export async function loadAppReadJobConfig(homePath: string): Promise<unknown> {
  try {
    const bytes=await readFile(join(homePath,"system/app-read-jobs.json"));
    if (bytes.length>65536) throw new AppReadJobError("invalid");
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code==="ENOENT") return {jobs:[]};
    throw error;
  }
}
function seed(job:ReadJob,ownerId:string):ReadRequest[] {
  const actions={github:"list_prs",linear:"list_issues",slack:"list_messages",posthog:"list_tickets"};
  return job.sources.map(source=>({ownerId,app:job.app,service:source.service,action:actions[source.service]!,connectionId:source.connectionId,label:source.label,params:source.params}));
}
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted){
    void work.catch(error=>{
      if(!(error instanceof Error&&["AbortError","TimeoutError"].includes(error.name)))
        console.warn("[app-read-jobs] cancelled operation failed:",error instanceof Error?error.name:"UnknownError");
    });
    return Promise.reject(new DOMException("Aborted","AbortError"));
  }
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException("Aborted","AbortError"));
    signal.addEventListener("abort",abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
  });
}
export function createAppReadJobRunner(options:{
  ownerId:string;store:AppReadJobStore;loadConfig():Promise<unknown>;read:ScopedRead;
  authorize(request:ReadRequest,signal:AbortSignal):Promise<void>;
  updateConfig?(app:string,jobId:string,settings:ReadJobSettings):Promise<unknown>;
  onSummary?(input:{ownerId:string;app:string;jobId:string;job:ReadJob;snapshots:Awaited<ReturnType<typeof collectReadJob>>["snapshots"]},signal:AbortSignal):Promise<JsonValue>;
  warn?(error:unknown):void;
}) {
  const active=new Map<string,{controller:AbortController;promise:Promise<void>}>(); // max8 from reviewed config
  type Admission={status:"accepted"|"busy"|"disabled"};
  const admissions=new Map<string,Promise<Admission>>(); // max8; includes pending DB claims
  let timer:ReturnType<typeof setInterval>|undefined;
  let polling:Promise<void>|null=null;
  let closed=false;
  const warn=(error:unknown)=>options.warn ? options.warn(error) : console.warn("[app-read-jobs] run unavailable:",error instanceof Error ? error.name : "UnknownError");
  async function config() { return ReadJobConfigSchema.parse(await options.loadConfig()); }
  async function selected(ownerId:string,app:string,jobId:string) {
    if (ownerId!==options.ownerId) throw new AppReadJobError("denied");
    const job=(await config()).jobs.find(item=>item.app===app&&item.id===jobId);
    if (!job) throw new AppReadJobError("invalid");
    await options.store.prepare(job);
    return job;
  }
  async function unchanged(job:ReadJob) {
    return (await config()).jobs.some(item=>item.enabled&&item.app===job.app&&item.id===job.id&&jobHash(item)===jobHash(job));
  }
  async function execute(job:ReadJob,claim:ReadJobClaim,controller:AbortController) {
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]);
    try {
      if(!await unchanged(job))throw new AppReadJobError("denied");
      const initial=seed(job,options.ownerId);
      for (const request of initial) await abortable(options.authorize(request,signal),signal);
      const previous=await options.store.snapshots(job);
      const output=await abortable(collectReadJob({job,ownerId:options.ownerId,read:async(request,requestSignal)=>{if(!await unchanged(job))throw new AppReadJobError("denied");return abortable(options.read(request,requestSignal),requestSignal);},signal,previous}),signal);
      if (!await unchanged(job)) throw new AppReadJobError("denied");
      const unique=Array.from(new Map([...initial,...output.requests].map(request=>[JSON.stringify(request),request])).values());
      for (const request of unique) await abortable(options.authorize(request,signal),signal);
      const hash=contentHash(output.snapshots);
      const state=await options.store.status(job);
      let summary:ReadJobSummary={status:"not_configured"};
      if (job.summary?.enabled) {
        if (!options.onSummary) summary={status:"unavailable"};
        else if (!summaryDue(job.summary,{at:state?.summaryAt??null,attemptedAt:state?.summaryAttemptAt??null,hash:state?.summaryHash??null},hash,new Date())) summary={status:"not_due"};
        else {
          if (!await options.store.markSummaryAttempt(job,claim)) throw new AppReadJobError("denied");
          try {
            const data=await abortable(options.onSummary({ownerId:options.ownerId,app:job.app,jobId:job.id,job,snapshots:output.snapshots},signal),signal);
            if (Buffer.byteLength(JSON.stringify(data))>40960) throw new AppReadJobError("invalid");
            summary={status:"completed",data,generatedAt:new Date().toISOString(),hash};
          } catch (error) {warn(error);summary={status:"unavailable"};}
        }
      }
      // Model work can outlive revocation; recheck both identity/config and exact grants again.
      if (!await unchanged(job)) throw new AppReadJobError("denied");
      if (summary.status==="completed") for (const request of unique) await abortable(options.authorize(request,signal),signal);
      signal.throwIfAborted();
      const status=output.snapshots.every(item=>item.coverage==="complete") ? "completed" : output.snapshots.every(item=>item.coverage==="unavailable") ? "failed" : "partial";
      await options.store.finish(job,claim,{snapshots:output.snapshots,status,summary});
    } catch (error) {
      warn(error);
      await options.store.finish(job,claim,{snapshots:[],status:"aborted"});
    }
  }
  function dispatch(input:ReadJob|(()=>Promise<ReadJob>),key:string,manual:boolean):Promise<Admission> {
    if(closed)return Promise.resolve({status:"disabled"});
    if(active.has(key)||admissions.has(key)||active.size+admissions.size>=8)return Promise.resolve({status:"busy"});
    const admission=(async():Promise<Admission>=>{
      const job=typeof input==="function"?await input():input;
      if(closed||!job.enabled)return {status:"disabled"};
      const claim=await options.store.claim(job,manual);
      if(!claim)return {status:closed?"disabled":"busy"};
      if(closed){await options.store.finish(job,claim,{status:"aborted",snapshots:[]});return {status:"disabled"};}
      const controller=new AbortController();
      const promise=execute(job,claim,controller).catch(warn).finally(()=>active.delete(key));
      active.set(key,{controller,promise});
      return {status:"accepted"};
    })().finally(()=>admissions.delete(key));
    admissions.set(key,admission);
    return admission;
  }
  async function tick() {
    if (closed||polling) return;
    polling=(async()=>{
      for (const job of (await config()).jobs) {
        if (closed) break;
        await options.store.prepare(job);
        await dispatch(job,`${job.app}/${job.id}`,false);
      }
    })().catch(warn).finally(()=>{polling=null;});
    await polling;
  }
  async function idle() { await polling; await Promise.allSettled(Array.from(admissions.values())); await Promise.all(Array.from(active.values(),value=>value.promise)); }
  return {
    start(){if (closed||timer) return; void tick();timer=setInterval(()=>void tick(),15000);timer.unref?.();},
    tick,idle,
    async stop(){closed=true;clearInterval(timer);timer=undefined;await polling;await Promise.allSettled(Array.from(admissions.values()));for(const item of active.values())item.controller.abort();await idle();active.clear();},
    async status(ownerId:string,app:string,jobId:string){
      const job=await selected(ownerId,app,jobId);
      const state=await options.store.status(job);
      return state?{...state,configuration:{enabled:job.enabled,intervalMs:job.intervalMs,sources:job.sources,...job.summary ? {summary:job.summary} : {}}}:null;
    },
    async configure(ownerId:string,app:string,jobId:string,settings:ReadJobSettings){
      const existing=await selected(ownerId,app,jobId);
      if(!options.updateConfig)throw new AppReadJobError("unavailable");
      const parsed=ReadJobSettingsSchema.safeParse(settings);
      if(!parsed.success)throw new AppReadJobError("invalid");
      const candidate=ReadJobSchema.parse({...existing,...parsed.data});
      const signal=AbortSignal.timeout(25000);
      try{
        for(const request of seed(candidate,options.ownerId))await abortable(options.authorize(request,signal),signal);
      }catch(error){
        const code=error instanceof Error&&"code" in error?error.code:null;
        throw new AppReadJobError(code==="denied"?"denied":code==="invalid"?"invalid":"unavailable");
      }
      // This writer only changes owner configuration; it never creates or widens an integration grant.
      await options.updateConfig(app,jobId,parsed.data);
      active.get(`${app}/${jobId}`)?.controller.abort();
      const job=await selected(ownerId,app,jobId);
      const state=await options.store.status(job);
      return state?{...state,configuration:{enabled:job.enabled,intervalMs:job.intervalMs,sources:job.sources,...job.summary ? {summary:job.summary} : {}}}:null;
    },
    async run(ownerId:string,app:string,jobId:string){if(ownerId!==options.ownerId)throw new AppReadJobError("denied");return dispatch(()=>selected(ownerId,app,jobId),`${app}/${jobId}`,true);},
    async pause(ownerId:string,app:string,jobId:string,paused:boolean){const job=await selected(ownerId,app,jobId);await options.store.setPaused(job,paused);if(paused)active.get(`${app}/${jobId}`)?.controller.abort();return options.store.status(job);},
  };
}
export type AppReadJobRunner=ReturnType<typeof createAppReadJobRunner>;
