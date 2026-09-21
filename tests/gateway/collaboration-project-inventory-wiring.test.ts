import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production project share inventory wiring", () => {
  it("constructs canonical Chat roots before registering the project inventory source", async () => {
    const server = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
    const rootInitialization = server.indexOf("canonicalChatExecutionRoots = createChatExecutionRootResolver(");
    const inventoryRegistration = server.indexOf("inventorySource: createGatewayProjectInventorySource(");
    const chatRootInjection = server.indexOf("chatRoots: createProjectChatRootInventory(");
    expect(rootInitialization).toBeGreaterThan(-1);
    expect(inventoryRegistration).toBeGreaterThan(rootInitialization);
    expect(chatRootInjection).toBeGreaterThan(inventoryRegistration);
  });
});
