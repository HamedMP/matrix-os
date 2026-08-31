import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelConfig, KernelEvent } from "@matrix-os/kernel";
import {
  createDispatcher,
  type SpawnFn,
} from "../../packages/gateway/src/dispatcher.js";

const temporaryHomePaths: string[] = [];

function makeHomePath(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "dispatch-overrides-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  temporaryHomePaths.push(dir);
  return dir;
}

function resultEvent(): KernelEvent {
  return {
    type: "result",
    data: { sessionId: "override-session", cost: 0, turns: 1 },
  };
}

describe("dispatcher per-message kernel overrides", () => {
  afterEach(() => {
    for (const homePath of temporaryHomePaths.splice(0)) {
      rmSync(homePath, { recursive: true, force: true });
    }
  });

  it("passes model and effort to the kernel for only the selected dispatch", async () => {
    const configs: KernelConfig[] = [];
    const spawn = vi.fn<SpawnFn>(async function* (_message, config) {
      configs.push(config);
      yield resultEvent();
    });
    const dispatcher = createDispatcher({
      homePath: makeHomePath(),
      model: "claude-opus-4-6",
      spawnFn: spawn,
      maxConcurrency: 1,
    });

    await dispatcher.dispatch(
      "override this turn",
      undefined,
      () => {},
      undefined,
      undefined,
      { model: "claude-haiku-4-5", effort: "low" },
    );
    await dispatcher.dispatch("use the default", undefined, () => {});

    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(configs[1]).toMatchObject({ model: "claude-opus-4-6" });
    expect(configs[1].effort).toBeUndefined();
  });

  it("routes an explicit access source for only the selected dispatch", async () => {
    const homePath = makeHomePath();
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-owner-key" } }),
    );
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "oauth-account" } }),
    );
    const configs: KernelConfig[] = [];
    const spawn = vi.fn<SpawnFn>(async function* (_message, config) {
      configs.push(config);
      yield resultEvent();
    });
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn, maxConcurrency: 1 });

    await dispatcher.dispatch(
      "use my profile",
      undefined,
      () => {},
      undefined,
      undefined,
      { accessSourceId: "owner_anthropic_profile" },
    );
    await dispatcher.dispatch("use the default", undefined, () => {});

    expect(configs[0].env?.HOME).toBe(homePath);
    expect(configs[0].env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(configs[1].env?.ANTHROPIC_API_KEY).toBe("sk-ant-owner-key");
  });

  it("passes a validated working directory to only the selected queued dispatch", async () => {
    const homePath = makeHomePath();
    const workingDirectory = resolve(homePath, "projects", "matrix-os", "repo");
    mkdirSync(workingDirectory, { recursive: true });
    const configs: KernelConfig[] = [];
    const spawn = vi.fn<SpawnFn>(async function* (_message, config) {
      configs.push(config);
      yield resultEvent();
    });
    const dispatcher = createDispatcher({
      homePath,
      spawnFn: spawn,
      maxConcurrency: 1,
    });

    const first = dispatcher.dispatch(
      "work in the selected project",
      "session-one",
      () => {},
      undefined,
      undefined,
      { workingDirectory },
    );
    const second = dispatcher.dispatch("use the home directory", "session-two", () => {});
    await Promise.all([first, second]);

    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ homePath, workingDirectory });
    expect(configs[1]).toMatchObject({ homePath });
    expect(configs[1].workingDirectory).toBeUndefined();
  });

  it("waits for async event admission before consuming the next kernel event", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const spawn = vi.fn<SpawnFn>(async function* () {
      yield { type: "init", sessionId: "provider-session" };
      order.push("kernel-next");
      yield resultEvent();
    });
    const dispatcher = createDispatcher({
      homePath: makeHomePath(),
      spawnFn: spawn,
      maxConcurrency: 1,
    });

    const dispatched = dispatcher.dispatch("first turn", "pending-session", async (event) => {
      if (event.type !== "init") return;
      order.push("adoption-start");
      await gate.promise;
      order.push("adoption-finished");
    });
    await vi.waitFor(() => expect(order).toEqual(["adoption-start"]));
    gate.resolve();
    await dispatched;

    expect(order).toEqual(["adoption-start", "adoption-finished", "kernel-next"]);
  });
});
