import { APP_BRIDGE_STORED_VALUE_PREFIX } from "@matrix-os/contracts";

// Ticket issuance, session setup, one home call and re-authentication can each take 10s.
const COLLABORATIVE_APP_BRIDGE_TIMEOUT_MS = 70_000;

export const COLLABORATIVE_APP_VIEW_ONLY_MESSAGE = "This app is view-only. Ask the owner to make it collaborative.";

/**
 * ENG-579: apps that aren't collaborative call the owner bridge's `db.*` and `readData`. On a
 * view-only share these map to the shared read path; every write rejects locally. The owner's
 * gateway refuses writes regardless, so this shim is compatibility, not enforcement.
 */
function readOnlyBridgeShim(): string {
  const prefix = JSON.stringify(APP_BRIDGE_STORED_VALUE_PREFIX);
  const viewOnly = JSON.stringify(COLLABORATIVE_APP_VIEW_ONLY_MESSAGE);
  return `const ro=()=>{parent.postMessage({type:"matrix:shared-app:view-only"},"*");return Promise.reject(new Error(${viewOnly}))};const q=a=>ask("matrix:shared-app:query",a).then(r=>r&&typeof r==="object"?r.result:r);const dec=v=>{if(typeof v!=="string"||v.indexOf(${prefix})!==0)return v;try{const e=JSON.parse(v.slice(${prefix}.length));if(e&&typeof e==="object"){if(e.undefined===true)return undefined;if(Object.prototype.hasOwnProperty.call(e,"value"))return e.value}}catch(error){console.warn("Matrix shared app value could not be decoded",error instanceof Error?error.name:"UnknownError")}return v};window.MatrixOS.db=Object.freeze({find:(table,o)=>{const b={action:"find",table};if(o){if(o.where)b.filter=o.where;if(o.orderBy)b.orderBy=o.orderBy;if(o.limit)b.limit=o.limit;if(o.offset)b.offset=o.offset}return q(b)},findOne:(table,id)=>q({action:"findOne",table,id}),count:(table,filter)=>q(filter===undefined?{action:"count",table}:{action:"count",table,filter}),insert:ro,bulkInsert:ro,update:ro,bulkUpdate:ro,compareAndSwap:ro,delete:ro,onChange:(table,cb)=>window.MatrixOS.collaboration.onChange(()=>cb({table}))});window.MatrixOS.readData=key=>ask("matrix:shared-app:read-data",String(key)).then(dec);window.MatrixOS.writeData=ro;window.MatrixOS.readOnly=true;`;
}

/** A capability-minimal iframe bridge: participant context, scoped query/mutate and original-write recovery only. */
export function collaborativeAppBridgeBootstrap(options: { readOnly?: boolean } = {}): string {
  return `<script>(()=>{const c=JSON.parse(document.getElementById("matrix-collaboration-context").textContent);const p=new Map();const l=new Set();const ask=(type,action,expectedRevision)=>new Promise((resolve,reject)=>{if(p.size>=32){reject(new Error("Shared app unavailable"));return}const requestId=crypto.randomUUID();const timer=setTimeout(()=>{p.delete(requestId);reject(new Error("Shared app unavailable"))},${COLLABORATIVE_APP_BRIDGE_TIMEOUT_MS});p.set(requestId,{resolve,reject,timer});parent.postMessage({type,requestId,...(action===undefined?{}:{action}),...(expectedRevision===undefined?{}:{expectedRevision})},"*")});addEventListener("message",event=>{if(event.source!==parent||event.origin!==location.origin)return;const m=event.data;if(m?.type==="matrix:shared-app:response"&&typeof m.requestId==="string"){const request=p.get(m.requestId);if(!request)return;p.delete(m.requestId);clearTimeout(request.timer);m.ok?request.resolve(m.result):request.reject(new Error(typeof m.message==="string"?m.message:"Shared app unavailable"));return}if(m?.type==="matrix:shared-app:changed")for(const listener of [...l])try{listener()}catch(error){console.warn("Matrix shared app change listener failed",error instanceof Error?error.name:"UnknownError")}});addEventListener("pagehide",()=>{for(const request of p.values()){clearTimeout(request.timer);request.reject(new Error("Shared app unavailable"))}p.clear();l.clear()},{once:true});window.MatrixOS=window.MatrixOS||{};window.MatrixOS.collaboration=Object.freeze({participant:Object.freeze(c),query:action=>ask("matrix:shared-app:query",action),mutate:(action,expectedRevision)=>ask("matrix:shared-app:mutate",action,expectedRevision),retryMutation:()=>ask("matrix:shared-app:retry"),onChange:listener=>{if(typeof listener!=="function"||l.size>=32)return()=>{};l.add(listener);return()=>l.delete(listener)}});${options.readOnly ? readOnlyBridgeShim() : ""}parent.postMessage({type:"matrix:shared-app:ready"},"*")})()</script>`;
}

