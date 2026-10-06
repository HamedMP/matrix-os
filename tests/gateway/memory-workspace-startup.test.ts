import { expect, it } from "vitest";
import { createGatewayMemoryWorkspace } from "../../packages/gateway/src/server/memory-workspace-runtime.js";
it("keeps missing database unavailable and authenticated rather than misreporting missing sources", async () => {
  const runtime = await createGatewayMemoryWorkspace(undefined);
  const response = await runtime.routes.request("/");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: "Memory workspace unavailable",
  });
  await runtime.close();
});
