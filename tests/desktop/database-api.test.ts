import { expect, it, vi } from "vitest";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
it("keeps authenticated database export pinned to its runtime with action headers and byte caps", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response("dump"));
  const api = createApiClient({baseUrl:"https://app.example",getRuntimeSlot:()=>"primary",fetchFn}).forRuntime("pr-42");
  const blob = await api.postBlob("/api/database/export",{confirm:"export"},{ headers:{"X-Matrix-Database-Action":"1"},maxBytes:4,timeoutMs:300000 });
  expect(blob.size).toBe(4);
  expect(fetchFn.mock.calls[0]).toEqual(["https://app.example/api/database/export?runtime=pr-42",expect.objectContaining({ method:"POST",cache:"no-store",headers:expect.objectContaining({"X-Matrix-Database-Action":"1","content-type":"application/json"}) })]);
  fetchFn.mockResolvedValue(new Response("large"));
  await expect(api.postBlob("/api/database/export",{}, {maxBytes:4})).rejects.toThrow();
});
it("allows database JSON actions to require their CSRF header without exposing auth", async () => {
  const fetchFn = vi.fn().mockResolvedValue(Response.json({}));
  await createApiClient({baseUrl:"https://app.example",getRuntimeSlot:()=>"primary",fetchFn}).post("/api/database/credentials/reveal",{}, {headers:{"X-Matrix-Database-Action":"1"},maxBytes:1024});
  expect(fetchFn.mock.calls[0][1]).toMatchObject({ cache:"no-store",headers:{"content-type":"application/json","X-Matrix-Database-Action":"1"} });
});
