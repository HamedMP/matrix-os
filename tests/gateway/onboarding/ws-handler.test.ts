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
import { createGeminiLiveClient } from "../../../packages/gateway/src/onboarding/gemini-live.js";
import type { GatewayToShell } from "../../../packages/gateway/src/onboarding/types.js";

const geminiMock = vi.hoisted(() => ({
  clients: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
    sendAudio: ReturnType<typeof vi.fn>;
    sendToolResponse: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../../packages/gateway/src/onboarding/gemini-live.js", () => ({
  hasGeminiLiveConnection: vi.fn((connection: unknown) => {
    if (!connection) return false;
    if (typeof connection === "string") return connection.length > 0;
    if (typeof connection === "object" && "proxy" in connection) {
      const proxy = (connection as { proxy?: { platformUrl?: string; handle?: string; token?: string } }).proxy;
      return Boolean(proxy?.platformUrl && proxy.handle && proxy.token);
    }
    return false;
  }),
  createGeminiLiveClient: vi.fn(() => {
    const client = {
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      sendText: vi.fn(),
      sendAudio: vi.fn(),
      sendToolResponse: vi.fn(),
    };
    geminiMock.clients.push(client);
    return client;
  }),
}));

describe("onboarding websocket handler", () => {
  let homePath: string;
  let sent: GatewayToShell[];

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "onboarding-ws-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    sent = [];
    geminiMock.clients.length = 0;
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_AUTH", "");
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function handler(
    geminiApiKey = "",
    readinessService?: Parameters<typeof createOnboardingHandler>[0]["readinessService"],
    ownerId?: string,
  ) {
    const resolvedOwnerId = arguments.length >= 3 ? ownerId : readinessService ? "owner_1" : undefined;
    const h = createOnboardingHandler({
      homePath,
      geminiApiKey,
      geminiModel: "test-model",
      readinessService,
      ownerId: resolvedOwnerId,
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

  it("returns goal steps for websocket goal selection", async () => {
    const readinessService = {
      getReadiness: vi.fn(async () => ({
        goals: [],
      })),
      selectGoals: vi.fn(async () => ({
        goalIds: ["coding" as const],
        steps: [
          { id: "github.connected", required: true, title: "Connect GitHub", unlocks: ["coding" as const] },
          { id: "project.selected", required: true, title: "Choose a project", unlocks: ["coding" as const] },
        ],
      })),
    };
    const h = handler("", readinessService);
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "select_goal", goalId: "coding" }));

    expect(readinessService.getReadiness).toHaveBeenCalledWith("owner_1");
    expect(readinessService.selectGoals).toHaveBeenCalledWith("owner_1", ["coding"]);
    expect(sent).toContainEqual(expect.objectContaining({
      type: "goal_selected",
      goalId: "coding",
      steps: expect.arrayContaining([
        expect.objectContaining({ id: "github.connected" }),
        expect.objectContaining({ id: "project.selected" }),
      ]),
    }));
  });

  it("does not persist websocket goal selection without a resolved owner", async () => {
    const readinessService = {
      getReadiness: vi.fn(async () => ({
        goals: [],
      })),
      selectGoals: vi.fn(async () => ({
        goalIds: ["coding" as const],
        steps: [],
      })),
    };
    const h = handler("", readinessService, undefined);
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "select_goal", goalId: "coding" }));

    expect(readinessService.getReadiness).not.toHaveBeenCalled();
    expect(readinessService.selectGoals).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({
      type: "goal_selected",
      goalId: "coding",
      steps: expect.arrayContaining([
        expect.objectContaining({ id: "github.connected" }),
      ]),
    }));
  });

  it("preserves previously selected goals when websocket goal selection persists", async () => {
    const readinessService = {
      getReadiness: vi.fn(async () => ({
        goals: [
          { id: "assistant" as const, selected: true },
          { id: "coding" as const, selected: false },
        ],
      })),
      selectGoals: vi.fn(async () => ({
        goalIds: ["assistant" as const, "coding" as const],
        steps: [
          { id: "integrations.capabilities", required: true, title: "Approve assistant capabilities", unlocks: ["assistant" as const] },
          { id: "github.connected", required: true, title: "Connect GitHub", unlocks: ["coding" as const] },
        ],
      })),
    };
    const h = handler("", readinessService);
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "select_goal", goalId: "coding" }));

    expect(readinessService.selectGoals).toHaveBeenCalledWith("owner_1", ["assistant", "coding"]);
    expect(sent).toContainEqual(expect.objectContaining({
      type: "goal_selected",
      goalId: "coding",
      steps: expect.arrayContaining([
        expect.objectContaining({ id: "integrations.capabilities" }),
        expect.objectContaining({ id: "github.connected" }),
      ]),
    }));
  });

  it("serializes rapid websocket goal selections so later writes include earlier goals", async () => {
    let selected: Array<"assistant" | "coding"> = [];
    const readinessService = {
      getReadiness: vi.fn(async () => ({
        goals: [
          { id: "assistant" as const, selected: selected.includes("assistant") },
          { id: "coding" as const, selected: selected.includes("coding") },
        ],
      })),
      selectGoals: vi.fn(async (_ownerId: string, goalIds: Array<"assistant" | "coding">) => {
        selected = goalIds;
        return {
          goalIds,
          steps: goalIds.map((id) => ({
            id: `${id}.step`,
            required: true,
            title: id,
            unlocks: [id],
          })),
        };
      }),
    };
    const h = handler("", readinessService);
    await h.onOpen((msg) => sent.push(msg));

    await Promise.all([
      h.onMessage(JSON.stringify({ type: "select_goal", goalId: "assistant" })),
      h.onMessage(JSON.stringify({ type: "select_goal", goalId: "coding" })),
    ]);

    expect(readinessService.selectGoals).toHaveBeenNthCalledWith(1, "owner_1", ["assistant"]);
    expect(readinessService.selectGoals).toHaveBeenNthCalledWith(2, "owner_1", ["assistant", "coding"]);
    expect(sent.filter((msg) => msg.type === "goal_selected")).toHaveLength(2);
  });

  it("reports onboarding failure telemetry when goal persistence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const readinessService = {
        getReadiness: vi.fn(async () => {
          throw new Error("postgres connection refused");
        }),
        selectGoals: vi.fn(),
      };
      const onFailure = vi.fn();
      const h = createOnboardingHandler({
        homePath,
        geminiApiKey: "",
        geminiModel: "test-model",
        readinessService,
        ownerId: "owner_1",
        onFailure,
      });
      await h.onOpen((msg) => sent.push(msg));

      await h.onMessage(JSON.stringify({ type: "select_goal", goalId: "coding" }));

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith({
        stage: "greeting",
        reasonKind: "goal_persistence_failed",
      });
      expect(JSON.stringify(onFailure.mock.calls)).not.toContain("postgres");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports onboarding failure telemetry when the Gemini Live connection fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(createGeminiLiveClient).mockImplementationOnce(() => ({
        on: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error("upstream socket reset")),
        close: vi.fn(),
        sendText: vi.fn(),
        sendAudio: vi.fn(),
        sendToolResponse: vi.fn(),
      }) as unknown as ReturnType<typeof createGeminiLiveClient>);
      const onFailure = vi.fn();
      const h = createOnboardingHandler({
        homePath,
        geminiApiKey: "test-gemini-key",
        geminiModel: "test-model",
        onFailure,
      });
      await h.onOpen((msg) => sent.push(msg));

      await h.onMessage(JSON.stringify({ type: "start", audioFormat: "pcm16" }));

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith({
        stage: "greeting",
        reasonKind: "gemini_connect_failed",
      });
      expect(JSON.stringify(onFailure.mock.calls)).not.toContain("socket reset");
      expect(sent).toContainEqual({ type: "mode_change", mode: "text" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never lets a throwing onFailure callback break the onboarding flow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const readinessService = {
        getReadiness: vi.fn(async () => {
          throw new Error("postgres connection refused");
        }),
        selectGoals: vi.fn(),
      };
      const h = createOnboardingHandler({
        homePath,
        geminiApiKey: "",
        geminiModel: "test-model",
        readinessService,
        ownerId: "owner_1",
        onFailure: () => {
          throw new Error("posthog down");
        },
      });
      await h.onOpen((msg) => sent.push(msg));

      await h.onMessage(JSON.stringify({ type: "select_goal", goalId: "coding" }));

      expect(sent).toContainEqual(expect.objectContaining({
        type: "error",
        code: "internal",
      }));
    } finally {
      warn.mockRestore();
    }
  });

  it("closes an existing Gemini client before handling a duplicate start", async () => {
    const h = handler("test-gemini-key");
    await h.onOpen((msg) => sent.push(msg));

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "pcm16" }));
    expect(geminiMock.clients).toHaveLength(1);
    expect(geminiMock.clients[0].close).not.toHaveBeenCalled();

    await h.onMessage(JSON.stringify({ type: "start", audioFormat: "text" }));

    expect(geminiMock.clients[0].close).toHaveBeenCalledOnce();
    expect(geminiMock.clients).toHaveLength(1);
    expect(sent).toContainEqual({ type: "mode_change", mode: "text" });
  });
});
