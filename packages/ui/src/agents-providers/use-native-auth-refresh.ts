import {useEffect,useRef} from "react";

// Renew before the native proof's 30-second expiry, leaving room for CLI/HTTP latency.
const CADENCE_MS=20_000;
const EVENT_DEBOUNCE_MS=500;
/** Only the visible Settings owner opts in; retained Chat consumers remain idle. */
export function useNativeAuthRefresh(owner:{refreshNativeAuthentication:(signal:AbortSignal)=>Promise<void>},enabled:boolean):void {
  const lifetime=useRef<{owner:typeof owner;lastStarted:number}|null>(null);
  useEffect(()=>{
    const resumed=lifetime.current?.owner===owner;
    if (!resumed) lifetime.current={owner,lastStarted:performance.now()};
    if (!enabled) return;
    const state=lifetime.current!;
    let alive=true,request:AbortController|null=null;
    let pendingEvent=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const visible=()=>document.visibilityState!=="hidden" && navigator.onLine!==false;
    const schedule=(delay=CADENCE_MS)=>{clearTimeout(timer);if(alive && visible())timer=setTimeout(check,delay);};
    const remainingDebounce=()=>Math.max(0,EVENT_DEBOUNCE_MS-(performance.now()-state.lastStarted));
    const check=()=>{
      clearTimeout(timer);
      if(!alive || !visible()){request?.abort();return;}
      if(request){pendingEvent=true;return;}
      const remaining=remainingDebounce();
      if(remaining>0){schedule(remaining);return;}
      pendingEvent=false;
      state.lastStarted=performance.now();request=new AbortController();const pending=request;
      void owner.refreshNativeAuthentication(pending.signal).catch((error:unknown)=>{
        if(!pending.signal.aborted)console.warn("[provider-settings] Native authentication refresh failed:",error instanceof Error?error.name:typeof error);
      }).finally(()=>{
        if(!alive || request!==pending)return;
        request=null;
        if(pendingEvent){pendingEvent=false;schedule(remainingDebounce());}else schedule();
      });
    };
    const reconcile=()=>{if(!visible()){pendingEvent=false;clearTimeout(timer);request?.abort();}else check();};
    window.addEventListener("focus",reconcile);window.addEventListener("online",reconcile);window.addEventListener("offline",reconcile);
    document.addEventListener("visibilitychange",reconcile);
    if(resumed)check();else schedule();
    return()=>{alive=false;clearTimeout(timer);request?.abort();window.removeEventListener("focus",reconcile);window.removeEventListener("online",reconcile);window.removeEventListener("offline",reconcile);document.removeEventListener("visibilitychange",reconcile);};
  },[owner,enabled]);
}
