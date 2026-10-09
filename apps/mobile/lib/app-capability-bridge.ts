import { AppAiInputSchema, AppCapabilityInputSchema, AppIdentitySchema, MAX_APP_CAPABILITY_BYTES, MAX_APP_BRIDGE_REPLY_BYTES, MAX_APP_RESPONSE_CHUNKS, MAX_APP_DATABASE_REPLY_BYTES, MAX_APP_DATABASE_REQUEST_BYTES, appRuntimeSlugFromIdentity, appCapabilityReplyBytes } from "@matrix-os/contracts";
import { appRuntimeNavigation } from "./app-runtime-navigation";

const MAX_BYTES = MAX_APP_DATABASE_REQUEST_BYTES + MAX_APP_CAPABILITY_BYTES;
const TIMEOUT_MS = 35_000;
// Matches the gateway and Electron app database name contract.
const SAFE_DATABASE_TABLE = /^[a-z][a-z0-9_-]{0,62}$/;
export type MobileAppBridgeRequest = (path: string, init: RequestInit) => Promise<Response>;

function bytes(value: string): number {
  // React Native does not guarantee TextEncoder on every supported device.
  return encodeURIComponent(value).replace(/%[A-F\d]{2}/gi, "x").length;
}

function requestFor(app: string, kind: unknown, input: unknown): { path: string; init: RequestInit } {
  if (kind === "capability") return { path: "/api/bridge/capabilities", init: { method: "POST", body: JSON.stringify({ app, input: AppCapabilityInputSchema.parse(input) }) } };
  if (kind === "ai") return { path: "/api/bridge/ai", init: { method: "POST", body: JSON.stringify({ app, ...AppAiInputSchema.parse(input) }) } };
  if (kind === "ai.routes") return { path: `/api/bridge/ai/routes?app=${encodeURIComponent(app)}`, init: { method: "GET" } };
  if (kind === "db" && input && typeof input === "object" && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if ((value.action !== "appInfo" && value.action !== "schema" && (typeof value.table !== "string" || !SAFE_DATABASE_TABLE.test(value.table))) || !["find", "findOne", "insert", "update", "delete", "bulkInsert", "bulkUpdate", "count", "appInfo", "schema"].includes(String(value.action))) throw new Error("Invalid app request");
    return { path: "/api/bridge/query", init: { method: "POST", body: JSON.stringify({ ...value, app }) } };
  }
  throw new Error("Invalid app request");
}

/** A broker is scoped to one launch; navigation/unmount destroys every pending request. */
export function createMobileAppCapabilityBroker(options: {
  app: string; runtimeUrl: string; runtimeSlug?: string; launchId: string; request: MobileAppBridgeRequest; reply: (script: string) => void;
}) {
  AppIdentitySchema.parse(options.app);
  const routeApp = new URL(options.runtimeUrl).pathname.match(/\/apps\/([a-z0-9][a-z0-9_-]{0,63})(?:\/|$)/)?.[1];
  // Explicit aliases come only from the authenticated native catalog/session flow.
  const runtimeSlug = options.runtimeSlug ?? appRuntimeSlugFromIdentity(options.app);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(runtimeSlug) || routeApp !== runtimeSlug || appRuntimeNavigation(options.runtimeUrl, options.runtimeUrl) !== "internal") throw new Error("App launch unavailable");
  const pending = new Map<number, AbortController>();
  let active = true;
  let documentId: string | null = null;
  let generation = 0;
  function resetDocument() {
    generation++;
    documentId = null;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  }
  function dispose() {
    active = false;
    resetDocument();
  }
  async function receive(data: string, sourceUrl: string): Promise<void> {
    if (!active || typeof data !== "string" || data.length > MAX_BYTES || appRuntimeNavigation(options.runtimeUrl, sourceUrl) !== "internal") return;
    let frame: Record<string, unknown>;
    try {
      if (bytes(data) > MAX_BYTES) return;
      frame = JSON.parse(data);
    } catch (error) {
      console.warn("[mobile-app-bridge] invalid frame", error instanceof Error ? error.name : "UnknownError");
      return;
    }
    if (!frame || frame.launchId !== options.launchId || (frame.kind !== "db" && bytes(data) > MAX_APP_CAPABILITY_BYTES)) return;
    if (frame.type === "matrix:app-ready" && typeof frame.documentId === "string" && /^[a-z0-9]{1,64}$/.test(frame.documentId)) {
      resetDocument();
      documentId = frame.documentId;
      return;
    }
    if (frame.documentId !== documentId || !documentId) return;
    const requestGeneration = generation;
    if (frame.type !== "matrix:app-request" || frame.launchId !== options.launchId || !Number.isSafeInteger(frame.id) || Number(frame.id) <= 0) return;
    const id = Number(frame.id);
    if (pending.has(id)) return;
    const send = (result: unknown) => {
      if (!active || generation !== requestGeneration) return;
      const json = JSON.stringify({ launchId: options.launchId, id, ...result as object });
      options.reply(`window.__matrixAppReply&&window.__matrixAppReply(${json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")});true;`);
    };
    if (pending.size >= 32) { send({ ok: false }); return; }
    const controller = new AbortController();
    pending.set(id, controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const { path, init } = requestFor(options.app, frame.kind, frame.input);
      if (path === "/api/bridge/query" && (typeof init.body !== "string" || bytes(init.body) > MAX_APP_DATABASE_REQUEST_BYTES)) throw new Error("Invalid app request");
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("App request unavailable")), { once: true });
      });
      const response = await Promise.race([options.request(path, { ...init, headers: { "content-type": "application/json" }, signal: controller.signal, redirect: "error" }), aborted]);
      if (!response.ok) throw new Error("App request unavailable");
      const maxReply = frame.kind === "db" ? MAX_APP_DATABASE_REPLY_BYTES : frame.kind === "capability" ? appCapabilityReplyBytes(AppCapabilityInputSchema.parse(frame.input)) : MAX_APP_BRIDGE_REPLY_BYTES;
      if (Number(response.headers.get("content-length")) > maxReply) { await response.body?.cancel(); throw new Error("App response unavailable"); }
      if (!response.body?.getReader) throw new Error("App response unavailable");
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(error => console.warn("[mobile-app-bridge] cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
      controller.signal.addEventListener("abort", cancel, {once:true});
      let text=""; let size=0; let chunks=0;
      const decoder=new TextDecoder();
      try {
        for (;;) {
          const chunk=await Promise.race([reader.read(),aborted]);
          if(chunk.done) break;
          size+=chunk.value.byteLength;
          if(size>maxReply || ++chunks>MAX_APP_RESPONSE_CHUNKS) { await reader.cancel(); throw new Error("App response unavailable"); }
          text+=decoder.decode(chunk.value,{stream:true});
        }
        text+=decoder.decode();
      } finally { controller.signal.removeEventListener("abort",cancel); reader.releaseLock(); }
      if (!controller.signal.aborted) send({ ok: true, body: JSON.parse(text) });
    } catch (error) {
      console.warn("[mobile-app-bridge] request unavailable", error instanceof Error ? error.name : "UnknownError");
      send({ ok: false });
    } finally {
      clearTimeout(timer);
      if (pending.get(id) === controller) pending.delete(id);
    }
  }
  return { receive, dispose, resetDocument };
}

/** Installed before app scripts; only request metadata enters the page. */
export function buildMobileAppBridgeScript(app: string, launchId: string): string {
  return `(function(){
    if(window.top && window.top!==window)return;
    var app=${JSON.stringify(app)}, launch=${JSON.stringify(launchId)}, documentId=Math.random().toString(36).slice(2)+Date.now().toString(36), pending={}, count=0, seq=0, subscriptions=[];
    function utf8Bytes(value){return encodeURIComponent(value).replace(/%[A-F0-9]{2}/gi,"x").length;}
    function mutate(table,input){return call("db",input).then(function(result){subscriptions.slice().forEach(function(item){if(item.table===table){try{item.callback({table:table});}catch(error){console.warn("[mobile-app-bridge] data change callback failed",error&&error.name);}}});return result;});}
    function onChange(table,callback){if(typeof table!=="string"||!${SAFE_DATABASE_TABLE}.test(table)||typeof callback!=="function")throw new Error("Invalid database subscription");var item={table:table,callback:callback};subscriptions.push(item);if(subscriptions.length>64)subscriptions.shift();return function(){var index=subscriptions.indexOf(item);if(index>=0)subscriptions.splice(index,1);};}
    function call(kind,input){return new Promise(function(resolve,reject){
      var id=++seq, text=JSON.stringify({type:"matrix:app-request",launchId:launch,documentId:documentId,id:id,kind:kind,input:input});
      var maximum=kind==="db"?${MAX_APP_DATABASE_REQUEST_BYTES + MAX_APP_CAPABILITY_BYTES}:${MAX_APP_CAPABILITY_BYTES};
      if(count>=32||utf8Bytes(text)>maximum||(kind==="db"&&utf8Bytes(JSON.stringify(Object.assign({},input,{app:app})))>${MAX_APP_DATABASE_REQUEST_BYTES})){reject(new Error("App request unavailable"));return;}
      var timer=setTimeout(function(){delete pending[id];count--;reject(new Error("App request unavailable"));},35000);
      pending[id]={resolve:resolve,reject:reject,timer:timer};count++;
      window.ReactNativeWebView.postMessage(text);
    });}
    window.__matrixAppReply=function(reply){if(!reply||reply.launchId!==launch)return;var item=pending[reply.id];if(!item)return;clearTimeout(item.timer);delete pending[reply.id];count--;if(reply.ok)item.resolve(reply.body);else item.reject(new Error("App request unavailable"));};
    window.addEventListener("pagehide",function(){Object.keys(pending).forEach(function(id){var item=pending[id];clearTimeout(item.timer);item.reject(new Error("App request unavailable"));});pending={};count=0;subscriptions=[];});
    window.ReactNativeWebView.postMessage(JSON.stringify({type:"matrix:app-ready",launchId:launch,documentId:documentId}));
    window.MatrixOS={app:{name:${JSON.stringify(app)}},
      capabilities:function(){return call("capability",{kind:"capabilities"});},
      integrations:function(){return call("capability",{kind:"integrations.list"}).then(function(d){return d.services||[];});},
      describeService:function(service){return call("capability",{kind:"integrations.describe",service:service});},
      service:function(service,action,params,label){return call("capability",{kind:"integrations.call",service:service,action:action,params:params||{},label:label});},
      ai:{generate:function(input){return call("ai",input);},routes:function(){return call("ai.routes",{});}},
      db:{find:function(table,opts){opts=opts||{};return call("db",{action:"find",table:table,filter:opts.where,orderBy:opts.orderBy,limit:opts.limit,offset:opts.offset});},
        findOne:function(table,id){return call("db",{action:"findOne",table:table,id:id});},
        appInfo:function(){return call("db",{action:"appInfo"});},
        schema:function(){return call("db",{action:"schema"});},onChange:onChange,
        bulkInsert:function(table,rows){return mutate(table,{action:"bulkInsert",table:table,rows:rows});},
        bulkUpdate:function(table,updates){return mutate(table,{action:"bulkUpdate",table:table,updates:updates});},
        count:function(table,filter){return call("db",{action:"count",table:table,filter:filter}).then(function(d){return d.count;});},
        insert:function(table,data){return mutate(table,{action:"insert",table:table,data:data});},
        update:function(table,id,data){return mutate(table,{action:"update",table:table,id:id,data:data});},
        delete:function(table,id){return mutate(table,{action:"delete",table:table,id:id});}}
    };
  })();true;`;
}
