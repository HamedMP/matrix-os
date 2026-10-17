import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";
import { openNativeSharedBrowserRun } from "../../packages/gateway/src/chat/native-shared-browser-run.js";

const brokers: ReturnType<typeof createSharedBrowserBroker>[] = [];
afterEach(async () => { await Promise.all(brokers.splice(0).map(broker => broker.close())); });

describe("supervised native shared Chrome discovery", () => {
  it.each(["codex", "claude_code"] as const)("exposes %s's fixed tool without executing a browser action", async harness => {
    const driver = { execute: vi.fn(async () => ({ success: true })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
    const broker = createSharedBrowserBroker({ ownerId: "owner_browser", driver, setHumanControl: async () => {} });
    brokers.push(broker);
    const run = openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, {
      owner: { type: "personal", ownerId: "owner_browser" }, chatId: "chat_browser", runId: `run_${harness}`,
      permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal,
    });

    expect(run, "Supervised Chat must discover the shared Chrome tool instead of receiving no browser capability").toBeDefined();
    expect(run!.mcpServer.args).toEqual(["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"]);
    expect(driver.execute).not.toHaveBeenCalled();
    expect(broker.status().phase).toBe("idle");
    await run!.close();
  });
});
