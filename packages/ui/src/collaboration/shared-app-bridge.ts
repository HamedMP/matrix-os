import { CollaborationAppAssetPathSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const HTML_MAX_BYTES = 1024 * 1024;
const ASSET_MAX_BYTES = 1024 * 1024;
const MAX_ASSETS = 12;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const csp = [
  "default-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-src 'none'",
  "script-src 'unsafe-inline' data:", "style-src 'unsafe-inline'", "img-src data:", "font-src data:", "connect-src 'self'",
].join("; ");

function localAssetPath(value: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//") || value.includes("?") || value.includes("#")) {
    throw new Error("Unsupported shared app asset");
  }
  const path = value.replace(/^\/?(?:\.\/)?/, "");
  return CollaborationAppAssetPathSchema.parse(path);
}

/** Replace only bounded, local build assets. No credentialed URL enters the opaque iframe. */
export async function buildSharedAppDocument(api: CollaborationApi, scopeId: string, appId: string, role: "owner" | "editor" | "viewer"): Promise<string> {
  if (!api.getContent) throw new Error("Shared app assets unavailable");
  const base = `/api/collaboration/scopes/${encodeURIComponent(scopeId)}/apps/${encodeURIComponent(appId)}`;
  const html = await api.getContent(`${base}/assets/index.html`, { maxBytes: HTML_MAX_BYTES });
  if (html.status !== "ok" || html.size > HTML_MAX_BYTES || !/^text\/html(?:$|\b)/i.test(html.contentType)) throw new Error("Shared app HTML unavailable");
  const document = new DOMParser().parseFromString(utf8.decode(html.bytes), "text/html");
  let total = html.bytes.byteLength;
  const nodes = [...document.querySelectorAll("script[src], link[rel='stylesheet'][href]")];
  const modules = new Map<string, string>();
  const loading = new Set<string>();
  const readAsset = async (path: string) => {
    if (modules.size >= MAX_ASSETS && !modules.has(path)) throw new Error("Too many shared app assets");
    const asset = await api.getContent!(`${base}/assets/${path.split("/").map(encodeURIComponent).join("/")}`, { maxBytes: ASSET_MAX_BYTES });
    if (asset.status !== "ok" || asset.size > ASSET_MAX_BYTES) throw new Error("Shared app asset unavailable");
    total += asset.bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new Error("Shared app assets too large");
    return { value: utf8.decode(asset.bytes), contentType: asset.contentType };
  };
  const moduleUrl = async (path: string): Promise<string> => {
    const existing = modules.get(path);
    if (existing) return existing;
    if (loading.has(path)) throw new Error("Cyclic shared app module");
    if (modules.size + loading.size >= MAX_ASSETS) throw new Error("Too many shared app modules");
    loading.add(path);
    try {
      const asset = await readAsset(path);
      if (!/(?:java|ecma)script/i.test(asset.contentType)) throw new Error("Unsupported shared app script");
      const references = [...asset.value.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["'](\.\.?\/[^"']+\.js)["']/g)];
      let script = asset.value;
      for (const reference of references.reverse()) {
        const relative = reference[1]!;
        const full = localAssetPath(`${path.split("/").slice(0, -1).join("/")}/${relative}`.split("/")
          .reduce<string[]>((parts, part) => part === "." ? parts : part === ".." ? (parts.pop(), parts) : [...parts, part], []).join("/"));
        const url = await moduleUrl(full);
        const start = reference.index! + reference[0].indexOf(relative);
        script = script.slice(0, start) + url + script.slice(start + relative.length);
      }
      const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(script)}`;
      modules.set(path, url);
      return url;
    } finally {
      loading.delete(path);
    }
  };
  for (const preload of document.querySelectorAll("link[rel='modulepreload'][href]")) {
    localAssetPath(preload.getAttribute("href") ?? "");
    preload.remove();
  }
  if (nodes.length > MAX_ASSETS) throw new Error("Too many shared app assets");
  for (const node of nodes) {
    const isScript = node.tagName.toLowerCase() === "script";
    const path = localAssetPath(node.getAttribute(isScript ? "src" : "href") ?? "");
    if (isScript) {
      const script = document.createElement("script");
      if (node.getAttribute("type") === "module") script.type = "module";
      script.src = await moduleUrl(path);
      node.replaceWith(script);
    } else {
      const asset = await readAsset(path);
      const value = asset.value;
      if (!/^text\/css(?:$|\b)/i.test(asset.contentType) || /@import\b|url\s*\(/i.test(value)) throw new Error("Unsupported shared app style");
      const style = document.createElement("style");
      style.textContent = value.replace(/<\/style/gi, "<\\/style");
      node.replaceWith(style);
    }
  }
  // Relative URLs and remote resources cannot load inside this document. Reject
  // additional active resource tags rather than silently letting an app escape its scope.
  if (document.querySelector("script[src]:not([src^='data:text/javascript']), link[href], iframe, object, embed, form, base, meta[http-equiv='refresh']")) {
    throw new Error("Unsupported shared app resource");
  }
  document.querySelectorAll("meta[http-equiv='Content-Security-Policy']").forEach((node) => node.remove());
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = csp;
  document.head.prepend(policy);
  const bridge = document.createElement("script");
  bridge.textContent = bridgeScript(scopeId, appId, role);
  policy.after(bridge);
  const output = `<!doctype html>${document.documentElement.outerHTML}`;
  if (new TextEncoder().encode(output).byteLength > MAX_DOCUMENT_BYTES) throw new Error("Shared app document too large");
  return output;
}

function bridgeScript(scopeId: string, appId: string, role: string): string {
  const identity = JSON.stringify({ scopeId, appId, role }).replace(/</g, "\\u003c");
  return `(()=>{
    const identity=${identity};
    const listeners=[];
    const channel=new MessageChannel();
    const port=channel.port1;
    const pending=new Map();
    let nextId=0;
    port.onmessage=(event)=>{
      const data=event.data;
      if(!data||typeof data!=='object')return;
      if(data.type==='matrix:app-changed'&&data.scopeId===identity.scopeId&&data.appId===identity.appId){
        for(const listener of listeners.slice())if(!data.table||data.table===listener.table)listener.callback({table:listener.table});
        return;
      }
      if(data.type!=='matrix:app-result'||!Number.isSafeInteger(data.id))return;
      const entry=pending.get(data.id);
      if(!entry)return;
      pending.delete(data.id);clearTimeout(entry.timer);
      if(data.ok)entry.resolve(data.result);else entry.reject(new Error('App request unavailable'));
    };
    parent.postMessage({type:'matrix:app-bridge-ready',scopeId:identity.scopeId,appId:identity.appId},'*',[channel.port2]);
    function request(action){return new Promise((resolve,reject)=>{
      if(pending.size>=32){reject(new Error('Too many app requests'));return;}
      const id=++nextId;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('App request timed out'));},10000);
      pending.set(id,{resolve,reject,timer});
      port.postMessage({type:'matrix:app-query',scopeId:identity.scopeId,appId:identity.appId,id,action});
    });}
    function call(action,fields){return request({app:identity.appId,action,...fields});}
    window.MatrixOS={app:{name:identity.appId},db:{
      find:(table,opts={})=>call('find',{table,...(opts.where?{filter:opts.where}:{}),...(opts.orderBy?{orderBy:opts.orderBy}:{}),...(opts.limit?{limit:opts.limit}:{}),...(opts.offset?{offset:opts.offset}:{})}),
      findOne:(table,id)=>call('findOne',{table,id}),count:(table,filter)=>call('count',{table,...(filter?{filter}:{})}),
      schema:()=>call('schema',{}),appInfo:()=>call('appInfo',{}),
      insert:(table,data)=>call('insert',{table,data}),bulkInsert:(table,rows)=>call('bulkInsert',{table,rows}),
      update:(table,id,data)=>call('update',{table,id,data}),bulkUpdate:(table,updates)=>call('bulkUpdate',{table,updates}),
      delete:(table,id)=>call('delete',{table,id}),
      onChange:(table,callback)=>{if(listeners.length>=32)throw new Error('Too many app listeners');
        const listener={table,callback};listeners.push(listener);
        return ()=>{const index=listeners.indexOf(listener);if(index>=0)listeners.splice(index,1);};}
    },
    readData:(key)=>call('readData',{key}).then((stored)=>{
      if(stored===null)return null;
      if(typeof stored!=='string')throw new Error('App data unavailable');
      const envelope=JSON.parse(stored);
      if(!envelope||typeof envelope!=='object')throw new Error('App data unavailable');
      if(envelope.undefined===true)return undefined;
      if(Object.prototype.hasOwnProperty.call(envelope,'value'))return envelope.value;
      throw new Error('App data unavailable');
    }),
    writeData:(key,value)=>call('writeData',{key,value:JSON.stringify(value===undefined?{undefined:true}:{value})}).then(()=>undefined)
    };
  })();`;
}

export const SharedAppMessageSchema = z.object({
  type: z.literal("matrix:app-query"), scopeId: z.string(), appId: z.string(), id: z.number().int().nonnegative(), action: z.json(),
}).strict();

export const SHARED_APP_READ_ACTIONS = new Set(["find", "findOne", "count", "schema", "appInfo", "readData"]);
export const SHARED_APP_WRITE_ACTIONS = new Set(["insert", "bulkInsert", "update", "bulkUpdate", "delete", "writeData"]);
