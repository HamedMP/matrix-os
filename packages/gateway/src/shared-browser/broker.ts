import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SHARED_BROWSER_ACTION_DEADLINE_MS, SharedBrowserActionSchema, SharedBrowserControlSchema, type SharedBrowserAction,
  type SharedBrowserActionResult, type SharedBrowserControl, type SharedBrowserState } from "@matrix-os/contracts";

export interface SharedBrowserBinding { ownerId: string; chatId: string; runId: string; harness: "pi" | "openclaw" | "hermes" }
export interface SharedBrowserDriver {
  execute(input: SharedBrowserAction, signal: AbortSignal): Promise<SharedBrowserActionResult>;
  invalidateObservation(): void;
  detach(): Promise<void>;
}
export class SharedBrowserError extends Error {
  constructor(readonly code: "run_unavailable" | "browser_busy" | "browser_changed" | "observe_again" | "browser_unavailable" | "invalid_action", readonly dispatched = false) {
    super(code === "observe_again" ? "Observe Chrome again before continuing." : code === "browser_busy" ? "Chrome is controlled by another Chat."
      : code === "browser_changed" ? "Browser control changed. Observe again after the owner resumes." : "The browser action is unavailable.");
    this.name = "SharedBrowserError";
  }
}
interface Registered { binding: SharedBrowserBinding; signal: AbortSignal; controller: AbortController; expiresAt: number; hash: Buffer; onAbort(): void; closing?:Promise<void>; collectionId:string; artifacts:NonNullable<SharedBrowserActionResult["artifact"]>[] }
const digest = (value: string) => createHash("sha256").update(value).digest();
const same = (a:SharedBrowserBinding,b:SharedBrowserBinding) => a.ownerId===b.ownerId && a.chatId===b.chatId && a.runId===b.runId && a.harness===b.harness;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createSharedBrowserBroker(options: {
  ownerId: string; driver: SharedBrowserDriver; setHumanControl(enabled:boolean):Promise<void>;
  runTtlMs?: number; drainTimeoutMs?: number; now?:()=>number;
  exportArtifacts?(collectionId:string,artifacts:NonNullable<SharedBrowserActionResult["artifact"]>[]):Promise<string>;
}) {
  const runs = new Map<string,Registered>(); // <=64, signal/TTL/close eviction; no persisted authority.
  const now = options.now ?? Date.now;
  const ttl = Math.min(options.runTtlMs ?? 30*60_000,30*60_000);
  const drainMs = Math.min(options.drainTimeoutMs ?? 8000,8000);
  let active: Registered | undefined;
  let phase: SharedBrowserState["phase"]="idle", revision=0, needsObservation=true, closed=false;
  let handoff: SharedBrowserState["handoff"];
  let actionTail:Promise<void>=Promise.resolve(), running:Promise<unknown>|undefined, queued=0;
  let controlTail:Promise<void>=Promise.resolve(), controls=0;
  let waitingResume: { row: Registered; finish(error?:SharedBrowserError):void } | undefined;
  const report=(error:unknown)=>console.warn("[shared-browser] Operation unavailable",error instanceof SharedBrowserError?error.code:"operation_failed");
  const status=():SharedBrowserState=>({phase,revision,needsObservation,run:active?{chatId:active.binding.chatId,runId:active.binding.runId,harness:active.binding.harness}:null,...(handoff?{handoff}:{})});
  const changed=(next:SharedBrowserState["phase"])=>{phase=next;if(["idle","agent","unavailable"].includes(next))handoff=undefined;revision++;needsObservation=true;options.driver.invalidateObservation();};
  const unavailable=()=>{changed("unavailable");return new SharedBrowserError("browser_unavailable");};
  function registered(binding:SharedBrowserBinding,caller?:AbortSignal):Registered {
    const row=runs.get(binding.runId);
    if(closed || !row || !same(row.binding,binding) || row.controller.signal.aborted || row.signal.aborted || caller?.aborted || row.expiresAt<=now()) throw new SharedBrowserError("run_unavailable");
    return row;
  }
  async function gate(enabled:boolean) { try{await options.setHumanControl(enabled);}catch(error){report(error);throw unavailable();} }
  async function detach() { try{await options.driver.detach();}catch(error){report(error);throw unavailable();} }
  async function drain() {
    if(!running)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try { await Promise.race([running.catch(report),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SharedBrowserError("browser_unavailable")),drainMs);})]); }
    catch(error){report(error);throw unavailable();} finally{clearTimeout(timer);}
  }
  function erase(row:Registered) { row.signal.removeEventListener("abort",row.onAbort);row.controller.abort();if(waitingResume?.row===row)waitingResume.finish(new SharedBrowserError("run_unavailable")); }
  function enqueueControl<T>(operation:()=>Promise<T>,cleanup=false):Promise<T> {
    if(!cleanup && controls>=4)throw new SharedBrowserError("browser_busy");
    controls++;
    const result=controlTail.then(operation).finally(()=>{controls--;});
    controlTail=result.then(()=>{},report);return result;
  }
  async function closeRun(runId:string) {
    const row=runs.get(runId);if(!row)return;
    if(row.closing)return row.closing;
    erase(row);
    if(active!==row){runs.delete(runId);return;}
    changed("pausing");
    row.closing=enqueueControl(async()=>{
      await drain();if(active!==row)return;
      await detach();await gate(true);active=undefined;changed("idle");
    },true).finally(()=>{if(runs.get(runId)===row)runs.delete(runId);});
    return row.closing;
  }
  const sweep=()=>{for(const row of runs.values())if(row.signal.aborted || row.expiresAt<=now())void closeRun(row.binding.runId).catch(report);};
  const timer=setInterval(sweep,15_000);timer.unref();
  function openRun(binding:SharedBrowserBinding,signal:AbortSignal) {
    sweep();
    if(closed || signal.aborted || binding.ownerId!==options.ownerId || ![binding.chatId,binding.runId].every(x=>SAFE_ID.test(x))
      || !["pi","openclaw","hermes"].includes(binding.harness) || runs.has(binding.runId) || runs.size>=64)throw new SharedBrowserError("run_unavailable");
    const token=randomBytes(32).toString("base64url");
    const row:Registered={binding:{...binding},signal,controller:new AbortController(),expiresAt:now()+ttl,hash:digest(token),collectionId:randomUUID(),artifacts:[],
      onAbort:()=>{void closeRun(binding.runId).catch(report);}};
    runs.set(binding.runId,row);signal.addEventListener("abort",row.onAbort,{once:true});
    return{token,expiresAt:row.expiresAt};
  }
  function resolveCapability(token:string):SharedBrowserBinding|null {
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    const hash=digest(token);
    for(const row of runs.values())if(timingSafeEqual(row.hash,hash)){try{return{...registered(row.binding).binding};}catch(error){if(error instanceof SharedBrowserError)return null;throw error;}}
    return null;
  }
  async function awaitResume(row:Registered,signal:AbortSignal) {
    if(waitingResume)throw new SharedBrowserError("browser_busy");
    await new Promise<void>((resolve,reject)=>{
      const signals=[signal,row.signal,row.controller.signal];
      const abort=()=>finish(new SharedBrowserError("run_unavailable"));
      const timer=setTimeout(abort,Math.max(1,Math.min(5*60_000,row.expiresAt-now())));
      const finish=(error?:SharedBrowserError)=>{
        if(waitingResume?.row!==row)return;
        waitingResume=undefined;clearTimeout(timer);for(const source of signals)source.removeEventListener("abort",abort);
        if(error)reject(error);else resolve();
      };
      waitingResume={row,finish};for(const source of signals)source.addEventListener("abort",abort,{once:true});
      if(signals.some(source=>source.aborted))abort();
    });
  }
  async function execute(binding:SharedBrowserBinding,raw:SharedBrowserAction,signal:AbortSignal):Promise<SharedBrowserActionResult> {
    const parsed=SharedBrowserActionSchema.safeParse(raw);if(!parsed.success)throw new SharedBrowserError("invalid_action");
    const row=registered(binding,signal);
    if(parsed.data.action==="status")return{success:true,automation:status()};
    if(controls>0)throw new SharedBrowserError("browser_changed");
    if(queued>=16)throw new SharedBrowserError("browser_busy");
    let admittedRevision=revision;
    if(active && active!==row)throw new SharedBrowserError("browser_busy");
    if(active && ["human","paused"].includes(phase)){
      await awaitResume(row,signal);registered(binding,signal);
      await controlTail;
      if(parsed.data.action!=="snapshot")throw new SharedBrowserError("observe_again");
      admittedRevision=revision;
    }
    if(!["idle","agent"].includes(phase))throw new SharedBrowserError("browser_changed");
    if(active && phase!=="agent")throw new SharedBrowserError("browser_changed");
    queued++;
    const result=actionTail.then(async()=>{
      if(registered(binding,signal)!==row)throw new SharedBrowserError("run_unavailable");
      if(admittedRevision!==revision || active && active!==row || active && phase!=="agent")throw new SharedBrowserError("browser_changed");
      const request=(async()=>{
        if(!active){active=row;changed("resuming");const claimRevision=revision;await gate(false);if(registered(binding,signal)!==row)throw new SharedBrowserError("run_unavailable");
          if(revision!==claimRevision || phase!=="resuming")throw new SharedBrowserError("browser_changed");changed("agent");}
        if(needsObservation && ["click","type","select","wait","download"].includes(parsed.data.action))throw new SharedBrowserError("observe_again");
        if(parsed.data.action==="download" && row.artifacts.length>=64)throw new SharedBrowserError("browser_busy");
        const value=await options.driver.execute(parsed.data,AbortSignal.any([signal,row.signal,row.controller.signal,AbortSignal.timeout(30_000)]));
        if(parsed.data.action==="download" && value.success && value.artifact){
          row.artifacts.push(value.artifact);
          if(options.exportArtifacts)try{value.collectionManifest=await options.exportArtifacts(row.collectionId,[...row.artifacts]);}
          catch(error){report(error);value.success=false;value.content="The original document was saved, but its collection manifest needs owner review before continuing.";}
        }
        // A completed recovery handoff must reach owner control even when the
        // individual action was cancelled. The run registration still has to
        // be live; only the already-finished action signal is ignored here.
        if(registered(binding,value.success||!value.handoffRequested?signal:undefined)!==row)throw new SharedBrowserError("run_unavailable");
        if(phase==="agent")needsObservation=parsed.data.action!=="snapshot" || !value.success || !value.observationId;return value;
      })();
      running=request;
      let value:SharedBrowserActionResult;
      try {
        try { value=await request; }
        finally {if(running===request)running=undefined;}
      } catch(error) {
        if(error instanceof SharedBrowserError) {
          if(error.code==="browser_unavailable")unavailable();
          else if(error.dispatched && active===row) {
            changed(phase);
            // An acknowledged cancellation may already have changed the page.
            // Drain/detach before owner review; never replay its queued successor.
            if(phase==="agent")await control(options.ownerId,{action:"takeover"});
          }
          throw error;
        }
        report(error);throw unavailable();
      }
      // A credential or download-recovery handoff must finish controller cleanup
      // before acknowledging owner input; do not drain our own running promise.
      if(!value.success && active===row && phase==="agent"){
        if(value.handoffRequested&&value.content)handoff={content:value.content};
        await control(options.ownerId,{action:"takeover"});
        if(signal.aborted)throw new SharedBrowserError("run_unavailable");
      }
      return value;
    }).finally(()=>{queued--;});
    actionTail=result.then(()=>{},report);
    const value=await result;
    if(value.success || !value.handoffRequested)return value;
    // Keep the native tool call alive while the owner signs in. Wait outside
    // actionTail so Resume can drain/detach; resume observation, never the
    // original mutation. Recursive handoffs inherit this first deadline.
    const resumedSignal=AbortSignal.any([signal,AbortSignal.timeout(SHARED_BROWSER_ACTION_DEADLINE_MS)]);
    if(registered(binding,resumedSignal)!==row)throw new SharedBrowserError("run_unavailable");
    await controlTail;
    if(active!==row)throw new SharedBrowserError("run_unavailable");
    if(["human","paused"].includes(phase))await awaitResume(row,resumedSignal);
    if(registered(binding,resumedSignal)!==row)throw new SharedBrowserError("run_unavailable");
    await controlTail;
    if(active!==row || phase!=="agent")throw new SharedBrowserError("browser_changed");
    const resumed=await execute(binding,{action:"snapshot"},resumedSignal);
    if(!value.content)return resumed;
    return{...resumed,content:[value.content,resumed.content].filter((content):content is string=>Boolean(content)).join("\n\n").slice(0,32_000)};
  }
  async function control(ownerId:string,raw:SharedBrowserControl):Promise<SharedBrowserState> {
    if(closed || ownerId!==options.ownerId)throw new SharedBrowserError("run_unavailable");
    const parsed=SharedBrowserControlSchema.safeParse(raw);if(!parsed.success)throw new SharedBrowserError("invalid_action");
    if(controls>=4)throw new SharedBrowserError("browser_busy");
    const {action}=parsed.data;
    if(action==="pause" && !active)throw new SharedBrowserError("run_unavailable");
    // Invalidate queued work immediately, before waiting for the current action.
    if(action!=="resume")changed("pausing");
    return enqueueControl(async()=>{
      if(closed)throw new SharedBrowserError("run_unavailable");
      await drain();
      if(action==="stop") { const row=active;if(row)erase(row);await detach();await gate(true);active=undefined;if(row)runs.delete(row.binding.runId);changed("idle"); }
      else if(action==="resume") {
        const row=active;
        if(!row || !["human","paused"].includes(phase))throw new SharedBrowserError("run_unavailable");
        registered(row.binding);changed("resuming");const resumeRevision=revision;await gate(false);registered(row.binding);
        if(active!==row || revision!==resumeRevision || phase!=="resuming")throw new SharedBrowserError("browser_changed");
        changed("agent");waitingResume?.finish();
      } else { await detach();await gate(action==="takeover"); changed(active?(action==="takeover"?"human":"paused"):"idle"); }
      return status();
    });
  }
  function ownerOperation<T>(ownerId:string,operation:()=>Promise<T>):Promise<T> {
    if(closed || ownerId!==options.ownerId || controls>0 || !["idle","human"].includes(phase))throw new SharedBrowserError("browser_changed");
    return enqueueControl(async()=>{
      if(closed || !["idle","human"].includes(phase))throw new SharedBrowserError("browser_changed");
      return operation();
    });
  }
  async function close() {
    if(closed)return;closed=true;clearInterval(timer);
    for(const row of runs.values())erase(row);
    changed("pausing");
    try{await enqueueControl(async()=>{await drain();await detach();await gate(true);active=undefined;runs.clear();changed("idle");},true);}catch(error){report(error);}
  }
  return{openRun,execute,closeRun,resolveCapability,status,control,ownerOperation,close};
}
export type SharedBrowserBroker=ReturnType<typeof createSharedBrowserBroker>;
