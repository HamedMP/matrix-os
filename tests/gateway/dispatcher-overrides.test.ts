import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
});
