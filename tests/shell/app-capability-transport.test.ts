import { describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import { buildBridgeScript, handleBridgeMessage, encodeBridgeStoredValue } from "../../shell/src/lib/os-bridge.js";
import { prepareAppCapabilityRequest, prepareAppBridgeFetch, readAppBridgeResponse } from "../../shell/src/components/app-capability-request.js";
import { appIdentityFromPath, extractSlug } from "../../shell/src/components/app-viewer-helpers.js";
import { buildMobileAppBridgeScript, createMobileAppCapabilityBroker } from "../../apps/mobile/lib/app-capability-bridge.js";
import { BridgeQueryBodySchema } from "../../packages/gateway/src/app-db-contracts.js";
import { normalizeAppStorageSlug } from "../../packages/gateway/src/app-db-types.js";
import { MAX_APP_DATABASE_REPLY_BYTES } from "@matrix-os/contracts";

const runtime = "https://app.matrix-os.com/vm/test/apps/notes/?session=private";

describe("app capability transport", () => {
  it("keeps nested persisted identity distinct from its migrated runtime slug and another leaf app", async () => {
    const identity = appIdentityFromPath("apps/games/chess/index.html");
    expect(identity).toBe("games/chess");
    expect(appIdentityFromPath("apps/chess/index.html")).toBe("chess");
    expect(extractSlug("apps/games/chess/index.html")).toBe("chess");
    expect(extractSlug("apps/private/chess/index.html")).toBeNull();
    for (const url of ["/api/bridge/query", "/api/bridge/data"]) {
      expect(JSON.parse(prepareAppBridgeFetch(identity, url, { method: "POST", body: JSON.stringify({ app: "chess", action: "read", key: "scores" }) }).init.body as string).app).toBe("games/chess");
    }
    expect(JSON.parse(prepareAppCapabilityRequest(identity, { method: "POST", body: JSON.stringify({ kind: "integrations.list", app: "chess" }) }).body as string).app).toBe("games/chess");
    const url = "https://app.matrix-os.com/apps/chess/?session=fixture";
    const request = vi.fn(async () => Response.json({ services: [] })); const reply = vi.fn();
    const broker = createMobileAppCapabilityBroker({ app: identity, runtimeUrl: url, launchId: "launch", request, reply });
    await broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), url);
    await broker.receive(JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId: "doc", id: 1, kind: "capability", input: { kind: "integrations.list" } }), url);
    expect(JSON.parse(request.mock.calls[0][1].body as string).app).toBe("games/chess"); broker.dispose();
    expect(() => createMobileAppCapabilityBroker({ app: "private/chess", runtimeUrl: url, launchId: "launch", request, reply })).toThrow();
  });

  it("reads an existing 100-note database result above the integration budget without loss on web and native", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: String(index), text: "x".repeat(3 * 1024) }));
    const bound = prepareAppBridgeFetch("notes", "/api/bridge/query", { method: "POST", body: JSON.stringify({ action: "find", table: "notes" }) });
    expect(await readAppBridgeResponse(Response.json(rows), bound)).toEqual(rows);
    let context: ReturnType<typeof createContext>;
    const request = vi.fn(async (_path: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ app: "notes", action: "find", table: "notes", limit: 100, offset: 20 });
      return Response.json(rows);
    });
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply: script => runInContext(script, context) });
    context = createContext({ setTimeout, clearTimeout, console, window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage(data: string) { void broker.receive(data, runtime); } } } });
    runInContext(buildMobileAppBridgeScript("notes", "launch"), context);
    expect(await runInContext('window.MatrixOS.db.find("notes", {limit:100,offset:20})', context)).toEqual(rows);
    expect(request).toHaveBeenCalledOnce();
    broker.dispose();
  });

  it("round-trips legacy nested KV, DB and AI calls through the injected web script with their original namespace", async () => {
    const identity = appIdentityFromPath("apps/games/chess/index.html");
    const stored = new Map([["gameschess:scores", encodeBridgeStoredValue({ wins: 5 })], ["chess:scores", encodeBridgeStoredValue({ wins: 99 })]]);
    const observed: Array<{ url: string; app: string }> = [];
    class Channel {
      port1: any = { close() {}, onmessage: null };
      port2: any = { close() {}, postMessage: (data: unknown) => this.port1.onmessage({ data }), reply: (data: unknown) => this.port1.onmessage({ data }) };
    }
    const fetchData = vi.fn(async (action: "read" | "write", app: string, key: string, value?: string) => {
      const id = `${normalizeAppStorageSlug(app)}:${key}`;
      if (action === "write") stored.set(id, value!);
      return stored.get(id);
    });
    const context = createContext({
      MessageChannel: Channel, setTimeout, clearTimeout, console,
      document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild() {} } },
      window: { addEventListener() {}, parent: { postMessage(message: any, _target: any, ports: any[]) {
        expect(message.app).toBe(identity);
        if (message.type === "os:read-data" || message.type === "os:write-data") {
          handleBridgeMessage({ data: message, ports } as MessageEvent, { sendToKernel: vi.fn(), fetchData }, { expectedApp: identity });
          return;
        }
        const bound = prepareAppBridgeFetch(identity, message.payload.url, message.payload.init);
        const body = bound.init.body ? JSON.parse(bound.init.body as string) : null;
        observed.push({ url: bound.url, app: body?.app ?? new URL(bound.url, "https://fixture.test").searchParams.get("app")! });
        if (bound.url === "/api/bridge/query") {
          const query = BridgeQueryBodySchema.parse(body);
          expect(query.app).toBe("gameschess");
          ports[0].reply({ ok: true, body: [{ wins: 5 }] });
        } else if (bound.url === "/api/bridge/ai") ports[0].reply({ ok: true, body: { text: "result" } });
        else if (bound.url.startsWith("/api/bridge/ai/routes?")) ports[0].reply({ ok: true, body: { routes: [], defaultRoute: null } });
        else ports[0].reply({ ok: true, body: { version: 1, integrations: true, ai: true } });
      } } },
    });
    runInContext(buildBridgeScript(identity), context);
    expect(await runInContext('window.MatrixOS.readData("scores")', context)).toEqual({ wins: 5 });
    await runInContext('window.MatrixOS.writeData("scores", {wins:6})', context);
    expect(await runInContext('window.MatrixOS.readData("scores")', context)).toEqual({ wins: 6 });
    expect(stored.get("chess:scores")).toBe(encodeBridgeStoredValue({ wins: 99 }));
    expect(await runInContext('window.MatrixOS.db.find("scores", {limit:100,offset:20})', context)).toEqual([{ wins: 5 }]);
    await runInContext('window.MatrixOS.ai.generate({prompt:"chess"})', context);
    await runInContext('window.MatrixOS.ai.routes()', context);
    await runInContext('window.MatrixOS.capabilities()', context);
    expect(observed.map(entry => entry.app)).toEqual(Array(4).fill("games/chess"));
  });

  it("reads large legacy KV values and cancels database streams above the shared budget on web and native", async () => {
    const kv = { value: encodeBridgeStoredValue({ notes: "x".repeat(400 * 1024) }) };
    const data = prepareAppBridgeFetch("games/chess", "/api/bridge/data", { method: "POST", body: JSON.stringify({ action: "read", key: "notes" }) });
    expect(await readAppBridgeResponse(Response.json(kv), data)).toEqual(kv);
    const webCancel = vi.fn(); const nativeCancel = vi.fn();
    const oversized = (cancel: () => void) => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(MAX_APP_DATABASE_REPLY_BYTES + 1)); }, cancel }, { highWaterMark: 0 }));
    await expect(readAppBridgeResponse(oversized(webCancel), data)).rejects.toThrow("App response unavailable");
    expect(webCancel).toHaveBeenCalledOnce();
    const reply = vi.fn();
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request: async () => oversized(nativeCancel), reply });
    await broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), runtime);
    await broker.receive(JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId: "doc", id: 1, kind: "db", input: { action: "find", table: "notes", limit: 100, offset: 100 } }), runtime);
    expect(nativeCancel).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0]).toContain('"ok":false');
    broker.dispose();
  });
  it("binds app identity and ignores app hints", () => {
    const request = prepareAppCapabilityRequest("notes", { method: "POST", body: JSON.stringify({ kind: "integrations.list", app: "other" }) });
    expect(JSON.parse(request.body as string)).toEqual({ app: "notes", input: { kind: "integrations.list" } });
    expect(() => prepareAppCapabilityRequest("notes", { method: "POST", body: "{}" })).toThrow();
  });

  it("stamps AI catalog, legacy service calls, DB and data identities in the host", () => {
    expect(prepareAppBridgeFetch("notes", "/api/bridge/ai/routes", {}).url).toBe("/api/bridge/ai/routes?app=notes");
    for (const url of ["/api/bridge/query", "/api/bridge/data"]) {
      const bound = prepareAppBridgeFetch("notes", url, { method: "POST", body: JSON.stringify({ app: "other", action: "find", table: "items" }) });
      expect(JSON.parse(bound.init.body as string).app).toBe("notes");
    }
    const service = prepareAppBridgeFetch("notes", "/api/bridge/service", { method: "POST", body: JSON.stringify({ app: "other", service: "google-drive", action: "list_files" }) });
    expect(service.url).toBe("/api/bridge/capabilities");
    expect(JSON.parse(service.init.body as string)).toEqual({ app: "notes", input: { kind: "integrations.call", service: "google-drive", action: "list_files" } });
  });

  it("web bootstrap exposes real capability request/reply methods", async () => {
    const sent: any[] = [];
    class Channel {
      port1: any = { close() {}, onmessage: null };
      port2: any = { close() {}, reply: (data: unknown) => this.port1.onmessage({ data }) };
    }
    const context = createContext({
      MessageChannel: Channel, setTimeout, clearTimeout, console,
      document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild() {} } },
      window: { addEventListener() {}, parent: { postMessage(message: any, _target: any, ports: any[]) {
        sent.push(message);
        const bound = prepareAppBridgeFetch("notes", message.payload.url, message.payload.init);
        expect(JSON.parse(bound.init.body as string).app).toBe("notes");
        ports[0].reply({ ok: true, body: message.payload.init.body.includes("integrations.list") ? { services: [{ service: "google-drive" }] } : { version: 1, integrations: true, ai: true } });
      } } },
    });
    runInContext(buildBridgeScript("notes"), context);
    expect(await runInContext("window.MatrixOS.integrations()", context)).toEqual([{ service: "google-drive" }]);
    expect(await runInContext("window.MatrixOS.capabilities()", context)).toEqual({ version: 1, integrations: true, ai: true });
    expect(sent.every((entry) => entry.payload.url === "/api/bridge/capabilities")).toBe(true);
  });

  it("native bootstrap calls native host without projecting bearer/session credentials", async () => {
    const fetcher = vi.fn(async (_path: string, init: RequestInit) => new Response(JSON.stringify({ services: [{ service: "google-drive" }] })));
    let context: any;
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request: fetcher,
      reply: (script) => runInContext(script, context) });
    const script = buildMobileAppBridgeScript("notes", "launch");
    expect(script).not.toContain("session=private");
    context = createContext({ setTimeout, clearTimeout, console, window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage(data: string) { void broker.receive(data, runtime); } } } });
    runInContext(script, context);
    expect(await runInContext("window.MatrixOS.integrations()", context)).toEqual([{ service: "google-drive" }]);
    expect(fetcher).toHaveBeenCalledWith("/api/bridge/capabilities", expect.objectContaining({ body: JSON.stringify({ app: "notes", input: { kind: "integrations.list" } }) }));
    broker.dispose();
  });

  it("native database schema and local subscriptions match successful writes and unsubscribe",async()=>{
    let context:any;let failure=false;const listeners:Record<string,()=>void>={};
    const request=vi.fn(async(_path:string,init:RequestInit)=>failure?Response.json({error:"unavailable"},{status:503}):Response.json(JSON.parse(init.body as string).action==="schema"?{tables:{notes:{}}}:{id:"saved"}));
    const broker=createMobileAppCapabilityBroker({app:"notes",runtimeUrl:runtime,launchId:"launch",request,reply:script=>runInContext(script,context)});
    context=createContext({setTimeout,clearTimeout,console,events:[],window:{top:null,addEventListener(name:string,callback:()=>void){listeners[name]=callback;},ReactNativeWebView:{postMessage(data:string){void broker.receive(data,runtime);}}}});
    runInContext(buildMobileAppBridgeScript("notes","launch"),context);
    const unsubscribe=runInContext('window.MatrixOS.db.onChange("notes",function(event){events.push(event.table);})',context);
    runInContext('window.MatrixOS.db.onChange("notes",function(){throw new Error("callback failure");})',context);
    expect(await runInContext("window.MatrixOS.db.schema()",context)).toEqual({tables:{notes:{}}});
    await runInContext('window.MatrixOS.db.insert("notes",{title:"saved"})',context);expect(context.events).toEqual(["notes"]);
    failure=true;await expect(runInContext('window.MatrixOS.db.insert("notes",{title:"failed"})',context)).rejects.toThrow();expect(context.events).toEqual(["notes"]);
    unsubscribe();failure=false;await runInContext('window.MatrixOS.db.update("notes","saved",{title:"new"})',context);expect(context.events).toEqual(["notes"]);
    runInContext('for(var n=0;n<65;n++)window.MatrixOS.db.onChange("notes",function(){events.push("subscriber");})',context);
    await runInContext('window.MatrixOS.db.delete("notes","saved")',context);expect(context.events.filter((x:string)=>x==="subscriber")).toHaveLength(64);
    listeners.pagehide!();await runInContext('window.MatrixOS.db.insert("notes",{title:"after hide"})',context);expect(context.events.filter((x:string)=>x==="subscriber")).toHaveLength(64);
    broker.dispose();
  });

  it.each(["saved-notes", "a" + "-".repeat(62)])("native database reads and writes preserve the valid table %s", async (table) => {
    let context: ReturnType<typeof createContext>;
    const rows = [{ id: "saved", title: "saved note" }];
    const request = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).toBe("/api/bridge/query");
      const query = BridgeQueryBodySchema.parse(JSON.parse(init.body as string));
      expect(query).toMatchObject({ app: "notes", table });
      return Response.json(query.action === "find" ? rows : { id: "saved" });
    });
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply: script => runInContext(script, context) });
    context = createContext({ setTimeout, clearTimeout, console, table, window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage(data: string) { void broker.receive(data, runtime); } } } });
    try {
      runInContext(buildMobileAppBridgeScript("notes", "launch"), context);
      expect(await runInContext('window.MatrixOS.db.find(table, {limit:10})', context)).toEqual(rows);
      expect(await runInContext('window.MatrixOS.db.insert(table, {title:"saved note"})', context)).toEqual({ id: "saved" });
      expect(request).toHaveBeenCalledTimes(2);
    } finally { broker.dispose(); }
  });

  it("native hyphenated table subscriptions receive successful mutation callbacks and unsubscribe", async () => {
    let context: ReturnType<typeof createContext>;
    const request = vi.fn(async () => Response.json({ id: "saved" }));
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply: script => runInContext(script, context) });
    context = createContext({ setTimeout, clearTimeout, console, events: [], window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage(data: string) { void broker.receive(data, runtime); } } } });
    try {
      runInContext(buildMobileAppBridgeScript("notes", "launch"), context);
      const unsubscribe = runInContext('window.MatrixOS.db.onChange("saved-notes",function(event){events.push(event.table);})', context);
      await runInContext('window.MatrixOS.db.insert("saved-notes",{title:"saved"})', context);
      expect(context.events).toEqual(["saved-notes"]);
      unsubscribe();
      await runInContext('window.MatrixOS.db.delete("saved-notes","saved")', context);
      expect(context.events).toEqual(["saved-notes"]);
    } finally { broker.dispose(); }
  });

  it.each(["../saved-notes", "Saved-notes", "saved.notes", "saved-notes;DROP TABLE notes", "a".repeat(64), "", 7, null, ["saved-notes"]])("native rejects unsafe or non-string table %j before dispatch or subscription", async (table) => {
    const request = vi.fn(); const reply = vi.fn();
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply });
    const context = createContext({ setTimeout, clearTimeout, console, table, window: { top: null, addEventListener() {}, ReactNativeWebView: { postMessage() {} } } });
    try {
      runInContext(buildMobileAppBridgeScript("notes", "launch"), context);
      expect(() => runInContext('window.MatrixOS.db.onChange(table,function(){})', context)).toThrow("Invalid database subscription");
      await broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), runtime);
      await broker.receive(JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId: "doc", id: 1, kind: "db", input: { action: "find", table } }), runtime);
      expect(request).not.toHaveBeenCalled();
      expect(reply.mock.calls[0][0]).toContain('"ok":false');
    } finally { broker.dispose(); }
  });

  it("rejects wrong launch, navigation, malformed payload and stale replies", async () => {
    let resolve!: (value: Response) => void;
    const request = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const reply = vi.fn();
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply });
    const frame = (launchId = "launch") => JSON.stringify({ type: "matrix:app-request", launchId, documentId: "doc", id: 1, kind: "capability", input: { kind: "integrations.list" } });
    await broker.receive(frame("other"), runtime);
    await broker.receive(frame(), "https://evil.example/apps/notes/");
    await broker.receive("{", runtime);
    expect(request).not.toHaveBeenCalled();
    await broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), runtime);
    const pending = broker.receive(frame(), runtime);
    broker.dispose();
    resolve(new Response("{}"));
    await pending;
    expect(reply).not.toHaveBeenCalled();
  });
  it("rejects oversized UTF-8 inputs and streamed web replies", async () => {
    expect(() => prepareAppCapabilityRequest("notes", { method: "POST", body: JSON.stringify({ kind: "integrations.call", service: "google-drive", action: "list_files", params: { value: "漢".repeat(23_000) } }) })).toThrow();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(262_145)); controller.close(); } }));
    await expect(readAppBridgeResponse(response)).rejects.toThrow("App response unavailable");
  });

  it("cancels native chunked replies at the cap without buffering the remaining body", async () => {
    const cancel=vi.fn(); let pulls=0;
    const request=vi.fn(async()=>new Response(new ReadableStream({pull(controller){pulls++;if(pulls>3)controller.close();else controller.enqueue(new Uint8Array(262145));},cancel}),{headers:{"content-type":"application/json"}}));
    const reply=vi.fn();
    const broker=createMobileAppCapabilityBroker({app:"notes",runtimeUrl:runtime,launchId:"launch",request,reply});
    await broker.receive(JSON.stringify({type:"matrix:app-ready",launchId:"launch",documentId:"doc"}),runtime);
    const work=broker.receive(JSON.stringify({type:"matrix:app-request",launchId:"launch",documentId:"doc",id:1,kind:"capability",input:{kind:"integrations.list"}}),runtime);
    await vi.waitFor(()=>expect(cancel).toHaveBeenCalled());
    await work; expect(pulls).toBeLessThanOrEqual(2); expect(reply.mock.calls[0][0]).toContain('"ok":false'); broker.dispose();
  });
  it("rejects a nonstreaming native transport without invoking its unbounded text reader",async()=>{
    const text=vi.fn(async()=>"{}");const reply=vi.fn();
    const broker=createMobileAppCapabilityBroker({app:"notes",runtimeUrl:runtime,launchId:"launch",request:async()=>({ok:true,headers:new Headers(),body:null,text}) as Response,reply});
    await broker.receive(JSON.stringify({type:"matrix:app-ready",launchId:"launch",documentId:"doc"}),runtime);
    await broker.receive(JSON.stringify({type:"matrix:app-request",launchId:"launch",documentId:"doc",id:1,kind:"capability",input:{kind:"capabilities"}}),runtime);
    expect(text).not.toHaveBeenCalled();expect(reply.mock.calls[0][0]).toContain('"ok":false');broker.dispose();
  });

  it("accepts the same300KiB Gmail attachment through web and native hosts", async () => {
    const body={data:{content:"x".repeat(300*1024)}};
    const input={kind:"integrations.call",service:"gmail",action:"get_attachment",params:{messageId:"message",attachmentId:"attachment"}};
    const bound=prepareAppBridgeFetch("notes","/api/bridge/capabilities",{method:"POST",body:JSON.stringify(input)});
    expect(await readAppBridgeResponse(Response.json(body),bound)).toEqual(body);
    const reply=vi.fn();
    const broker=createMobileAppCapabilityBroker({app:"notes",runtimeUrl:runtime,launchId:"launch",request:async()=>Response.json(body),reply});
    await broker.receive(JSON.stringify({type:"matrix:app-ready",launchId:"launch",documentId:"doc"}),runtime);
    await broker.receive(JSON.stringify({type:"matrix:app-request",launchId:"launch",documentId:"doc",id:1,kind:"capability",input}),runtime);
    expect(reply.mock.calls[0][0]).toContain('"ok":true');broker.dispose();
  });

  it("permits delayed web AI discovery past10 seconds and uses the same host budget",async()=>{
    vi.useFakeTimers();
    try{
      const context=createContext({MessageChannel:class {port1:any={close(){},onmessage:null};port2:any={close(){},reply:(data:unknown)=>this.port1.onmessage({data})};},setTimeout,clearTimeout,console,document:{documentElement:{dataset:{}},createElement:()=>({}),head:{appendChild(){}}},window:{addEventListener(){},parent:{postMessage(_message:any,_target:any,ports:any[]){setTimeout(()=>ports[0].reply({ok:true,body:{routes:[],defaultRoute:null}}),11000);}}}});
      runInContext(buildBridgeScript("notes"),context);
      const result=runInContext("window.MatrixOS.ai.routes()",context);
      const assertion=expect(result).resolves.toEqual({routes:[],defaultRoute:null});
      await vi.advanceTimersByTimeAsync(11000);await assertion;
      const {appBridgeTimeoutMs}=await import("../../shell/src/components/app-capability-request.js");
      expect(appBridgeTimeoutMs("/api/bridge/ai/routes?app=notes")).toBe(35000);
    }finally{vi.useRealTimers();}
  });

  it("drains outstanding native requests on document navigation and rejects the old document", async () => {
    const request = vi.fn(() => new Promise<Response>(() => {}));
    const reply = vi.fn();
    const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply });
    const ready = (documentId: string) => JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId });
    const frame = (documentId: string, id = 1) => JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId, id, kind: "capability", input: { kind: "integrations.list" } });
    await broker.receive(ready("old"), runtime);
    const pending = broker.receive(frame("old"), runtime);
    broker.resetDocument();
    await broker.receive(ready("new"), runtime);
    await pending;
    await broker.receive(frame("old"), runtime);
    expect(request).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    broker.dispose();
  });

  it("caps pending native requests and settles timeouts even when the requester ignores abort", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(() => new Promise<Response>(() => {}));
      const reply = vi.fn();
      const broker = createMobileAppCapabilityBroker({ app: "notes", runtimeUrl: runtime, launchId: "launch", request, reply });
      await broker.receive(JSON.stringify({ type: "matrix:app-ready", launchId: "launch", documentId: "doc" }), runtime);
      const work: Promise<void>[] = [];
      for (let id = 1; id <= 33; id++) work.push(broker.receive(JSON.stringify({ type: "matrix:app-request", launchId: "launch", documentId: "doc", id, kind: "capability", input: { kind: "integrations.list" } }), runtime));
      expect(request).toHaveBeenCalledTimes(32);
      expect(reply).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(35_000);
      await Promise.all(work);
      expect(reply).toHaveBeenCalledTimes(33);
      broker.dispose();
    } finally { vi.useRealTimers(); }
  });

});

it.each(["/api/bridge/capabilities?x=1", "/api/bridge/capabilities/", "/api/bridge/a/../capabilities", "/api/bridge/ai/routes?app=other", "/api/bridge/query?app=other", "/api/bridge/service?app=other"])("rejects privileged endpoint aliases %s", async (url) => {
  const { isAllowedBridgeFetchUrl } = await import("../../shell/src/components/app-viewer-bridge-policy.js");
  expect(isAllowedBridgeFetchUrl("notes", url)).toBe(false);
});
