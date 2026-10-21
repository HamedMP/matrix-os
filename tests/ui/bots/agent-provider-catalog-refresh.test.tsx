// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentProviderCatalog } from "../../../packages/ui/src/chat-agents/use-agent-provider-catalog.js";
import { clientFixture } from "../../desktop/chat-agents-fixture.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
afterEach(cleanup);
function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:Error)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }

it("queues one forced discovery after pending initial discovery", async () => {
 const client=clientFixture();const initial=deferred<Awaited<ReturnType<typeof client.catalog>>>();
 client.catalog.mockReturnValueOnce(initial.promise);
 const {result}=renderHook(()=>useAgentProviderCatalog(client));
 act(()=>{result.current.refresh();result.current.refresh();});
 expect(client.catalog).toHaveBeenCalledTimes(1);
 await act(async()=>initial.resolve(createCanonicalProviderCatalogFixture()));
 await waitFor(()=>expect(client.catalog).toHaveBeenCalledTimes(2));
 expect(client.catalog).toHaveBeenLastCalledWith({refresh:true});
});

it("coalesces concurrent explicit refresh and does not poll while idle", async()=>{
 const client=clientFixture(); const {result}=renderHook(()=>useAgentProviderCatalog(client));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 const pending=deferred<Awaited<ReturnType<typeof client.catalog>>>();client.catalog.mockReturnValue(pending.promise);
 act(()=>{result.current.refresh(); result.current.refresh();});
 expect(client.catalog).toHaveBeenCalledTimes(2);expect(client.catalog).toHaveBeenLastCalledWith({refresh:true});
 const catalog=createCanonicalProviderCatalogFixture();catalog.catalogRevision="new-revision";
 await act(async()=>pending.resolve(catalog));expect(result.current.catalog).toEqual(catalog);
 await act(async()=>Promise.resolve()); expect(client.catalog).toHaveBeenCalledTimes(2);
});
it("fences old owner/runtime results and old request completion",async()=>{
 const old=clientFixture(), next=clientFixture();const pending=deferred<Awaited<ReturnType<typeof old.catalog>>>();old.catalog.mockReturnValue(pending.promise);
 const catalog=createCanonicalProviderCatalogFixture();catalog.catalogRevision="next-owner";next.catalog.mockResolvedValue(catalog);
 const {result,rerender}=renderHook(({client})=>useAgentProviderCatalog(client),{initialProps:{client:old}});
 rerender({client:next});await waitFor(()=>expect(result.current.catalog?.catalogRevision).toBe("next-owner"));
 await act(async()=>pending.resolve(createCanonicalProviderCatalogFixture()));expect(result.current.catalog).toEqual(catalog);
});
it("failed refresh drops stale executable choices and reports a safe retry state",async()=>{
 const client=clientFixture();const {result}=renderHook(()=>useAgentProviderCatalog(client));await waitFor(()=>expect(result.current.catalog).not.toBeNull());
 client.catalog.mockRejectedValue(new Error("secret account and path"));act(()=>result.current.refresh());await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.catalog).toBeNull();expect(result.current.error).toBe("Models could not be refreshed. Your draft is still here.");
});
