import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production project share inventory wiring", () => {
  it("constructs canonical Chat roots before registering the project inventory source", async () => {
    const server = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
    const rootInitialization = server.indexOf("const ownerChatExecutionRoots = createChatExecutionRootResolver(");
    const gitDriver = server.indexOf("const projectGitDriver = createProjectGitDriver(");
    const inventoryRegistration = server.indexOf("const inventorySource = createGatewayProjectInventorySource(");
    const chatRootInjection = server.indexOf("chatRoots: createProjectChatRootInventory(");
    const gitSetupInjection = server.indexOf("gitSetup: { get: projectGitDriver.getGitSetup }");
    const brokerRegistration = server.indexOf("runtime.enableProjectGit({ driver: projectGitDriver, source: inventorySource });");
    expect(rootInitialization).toBeGreaterThan(-1);
    expect(gitDriver).toBeGreaterThan(rootInitialization);
    expect(inventoryRegistration).toBeGreaterThan(gitDriver);
    expect(chatRootInjection).toBeGreaterThan(inventoryRegistration);
    expect(gitSetupInjection).toBeGreaterThan(inventoryRegistration);
    expect(brokerRegistration).toBeGreaterThan(gitSetupInjection);
  });

  it("resolves owner app catalog identities from the app registry, not the filesystem", async () => {
    const server = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
    const driver = server.indexOf("const resourceDriver = createOwnerResourceDriver({");
    const assetRoot = server.indexOf("resolveAppAssetRoot: async (", driver);
    const incarnation = server.indexOf("resolveAppIncarnation: async (", driver);
    expect(driver).toBeGreaterThan(-1);
    expect(incarnation).toBeGreaterThan(assetRoot);
    expect(server.slice(incarnation, incarnation + 400)).toContain("appRegistryIncarnation(");
  });
});
