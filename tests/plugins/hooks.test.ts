import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPluginRegistry, type PluginRegistry } from "../../packages/gateway/src/plugins/registry.js";
import { createHookRunner, type HookRunner } from "../../packages/gateway/src/plugins/hooks.js";
import type { BeforeToolCallResult, MessageSendingResult } from "../../packages/gateway/src/plugins/types.js";

describe("T937a: Hook runner", () => {
  let registry: PluginRegistry;
  let runner: HookRunner;

  beforeEach(() => {
    registry = createPluginRegistry();
    runner = createHookRunner(registry, { timeout: 1000 });
  });

  describe("void hooks", () => {
    it("all handlers run in parallel", async () => {
      const order: number[] = [];
      registry.registerHook("p1", "message_received", async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
      });
      registry.registerHook("p2", "message_received", async () => {
        order.push(2);
      });

      await runner.fireVoidHook("message_received", {});
      expect(order).toContain(1);
      expect(order).toContain(2);
    });

    it("one handler error does not block others", async () => {
      const executed: string[] = [];
      registry.registerHook("p1", "message_received", () => {
        throw new Error("handler1 failed");
      });
      registry.registerHook("p2", "message_received", () => {
        executed.push("p2");
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await runner.fireVoidHook("message_received", {});
      consoleSpy.mockRestore();

      expect(executed).toContain("p2");
    });

    it("passes context to handlers", async () => {
      let received: Record<string, unknown> = {};
      registry.registerHook("p1", "gateway_start", (ctx) => {
        received = ctx;
      });

      await runner.fireVoidHook("gateway_start", { port: 4000 });
      expect(received).toEqual({ port: 4000 });
    });

    it("does nothing when no hooks registered", async () => {
      await runner.fireVoidHook("gateway_stop", {});
    });
  });

  describe("modifying hooks", () => {
    it("run in priority order (higher first)", async () => {
      const order: number[] = [];
      registry.registerHook("p1", "before_tool_call", () => {
        order.push(1);
        return {};
      }, { priority: 1 });
      registry.registerHook("p2", "before_tool_call", () => {
        order.push(10);
        return {};
      }, { priority: 10 });
      registry.registerHook("p3", "before_tool_call", () => {
        order.push(5);
        return {};
      }, { priority: 5 });

      await runner.fireModifyingHook("before_tool_call", {});
      expect(order).toEqual([10, 5, 1]);
    });

    it("result merges across handlers", async () => {
      registry.registerHook("p1", "before_tool_call", () => {
        return { params: { extra: true } };
      }, { priority: 10 });
      registry.registerHook("p2", "before_tool_call", () => {
        return { blockReason: "test" };
      }, { priority: 5 });

      const result = await runner.fireModifyingHook<BeforeToolCallResult>("before_tool_call", {});
      expect(result).toEqual({ params: { extra: true }, blockReason: "test" });
    });

    it("before_tool_call: block=true prevents tool execution", async () => {
      registry.registerHook("p1", "before_tool_call", () => {
        return { block: true, blockReason: "Not allowed" } satisfies BeforeToolCallResult;
      });

      const result = await runner.fireModifyingHook<BeforeToolCallResult>("before_tool_call", { tool: "rm" });
      expect(result!.block).toBe(true);
      expect(result!.blockReason).toBe("Not allowed");
    });

    it("message_sending: cancel=true prevents message delivery", async () => {
      registry.registerHook("p1", "message_sending", () => {
        return { cancel: true } satisfies MessageSendingResult;
      });

      const result = await runner.fireModifyingHook<MessageSendingResult>("message_sending", { content: "hi" });
      expect(result!.cancel).toBe(true);
    });

    it("later handler can override earlier result", async () => {
      registry.registerHook("p1", "message_sending", () => {
        return { content: "modified by p1" } satisfies MessageSendingResult;
      }, { priority: 10 });
      registry.registerHook("p2", "message_sending", () => {
        return { content: "modified by p2" } satisfies MessageSendingResult;
      }, { priority: 5 });

      const result = await runner.fireModifyingHook<MessageSendingResult>("message_sending", {});
      expect(result!.content).toBe("modified by p2");
    });

    it("returns undefined when no hooks registered", async () => {
      const result = await runner.fireModifyingHook("before_agent_start", {});
      expect(result).toBeUndefined();
    });

    it("handler returning undefined is skipped in merge", async () => {
      registry.registerHook("p1", "before_tool_call", () => {
        return { block: true } satisfies BeforeToolCallResult;
      }, { priority: 10 });
      registry.registerHook("p2", "before_tool_call", () => {
        // return nothing
      }, { priority: 5 });

      const result = await runner.fireModifyingHook<BeforeToolCallResult>("before_tool_call", {});
      expect(result!.block).toBe(true);
    });
  });

  describe("timeouts", () => {
    it("handler killed after timeout, logged as error", async () => {
      const fastRunner = createHookRunner(registry, { timeout: 100 });

      registry.registerHook("slow-plugin", "message_received", async () => {
        await new Promise((r) => setTimeout(r, 500));
      });

      const calls: string[] = [];
      const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        calls.push(args.map(String).join(" "));
      });
      await fastRunner.fireVoidHook("message_received", {});
      consoleSpy.mockRestore();

      expect(calls.some((c) => c.includes("slow-plugin"))).toBe(true);
    });

    it("modifying hook timeout does not crash", async () => {
      const fastRunner = createHookRunner(registry, { timeout: 100 });

      registry.registerHook("slow-plugin", "before_tool_call", async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { block: true };
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await fastRunner.fireModifyingHook<BeforeToolCallResult>("before_tool_call", {});
      consoleSpy.mockRestore();

      expect(result).toBeUndefined();
    });
  });
});
