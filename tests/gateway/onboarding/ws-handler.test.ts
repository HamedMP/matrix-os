import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createOnboardingHandler } from "../../../packages/gateway/src/onboarding/ws-handler.js";
import type { GatewayToShell } from "../../../packages/gateway/src/onboarding/types.js";

describe("onboarding websocket handler", () => {
  let homePath: string;
  let sent: GatewayToShell[];

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "onboarding-ws-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    sent = [];
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_AUTH", "");
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function handler() {
    const h = createOnboardingHandler({
      homePath,
      geminiApiKey: "",
      geminiModel: "test-model",
    });
    return h;
  }

  it("routes the API-key activation path to api_key without completing onboarding", async () => {
    const h = handler();
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "text" }));
    await h.onMessage(JSON.stringify({ type: "choose_activation", path: "api_key" }));

    expect(sent).toContainEqual({ type: "stage", stage: "api_key" });
    expect(existsSync(join(homePath, "system/onboarding-complete.json"))).toBe(false);
  });

  it("allows explicit Claude Code activation to complete onboarding", async () => {
    const h = handler();
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "text" }));
    await h.onMessage(JSON.stringify({ type: "choose_activation", path: "claude_code" }));

    expect(sent).toContainEqual({ type: "stage", stage: "done" });
    expect(existsSync(join(homePath, "system/onboarding-complete.json"))).toBe(true);
  });
});
