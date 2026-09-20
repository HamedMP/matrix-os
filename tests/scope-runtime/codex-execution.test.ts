import { describe, expect, it } from "vitest";
import {
  buildScopeCodexExecLaunch,
  parseScopeCodexJsonEvents,
} from "../../packages/scope-runtime/src/worker.js";

describe("isolated Codex execution boundary", () => {
  it("builds an ephemeral pinned native invocation with a loopback-only Responses provider", () => {
    const launch = buildScopeCodexExecLaunch({
      bridgePort: 43117,
      model: "gpt-5.6-sol",
      prompt: "Summarize the visible shared discussion.",
    });

    expect(launch).toEqual({
      command: "/opt/matrix/runtime/node/bin/codex",
      args: expect.arrayContaining([
        "--ignore-user-config",
        "--strict-config",
        "--ask-for-approval", "never",
        "--disable", "shell_tool",
        "--disable", "view_image",
        "--disable", "sleep_tool",
        "--disable", "multi_agent",
        "--disable", "apps",
        "--disable", "plugins",
        "--disable", "goals",
        "exec",
        "--ephemeral",
        "--json",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--model", "gpt-5.6-sol",
        "--", "Summarize the visible shared discussion.",
      ]),
      env: {
        HOME: "/workspace",
        PATH: "/opt/matrix/runtime/node/bin",
        NO_COLOR: "1",
        MATRIX_SCOPE_RUNTIME: "1",
      },
    });
    expect(launch.args.join(" ")).toContain("http://127.0.0.1:43117/v1");
    expect(launch.args).toEqual(expect.arrayContaining([
      "--config", "tools.update_plan.enabled=false",
      "--config", "tools.experimental_request_user_input.enabled=false",
    ]));
    expect(JSON.stringify(launch)).not.toMatch(/API_KEY|AUTH_TOKEN|refresh_token|owner/i);
  });

  it("returns only the bounded final assistant message and rejects incomplete runs", () => {
    expect(parseScopeCodexJsonEvents([
      JSON.stringify({ type: "thread.started", thread_id: "thread_private" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Scoped answer" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } }),
    ])).toBe("Scoped answer");
    expect(() => parseScopeCodexJsonEvents([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial" } }),
      JSON.stringify({ type: "turn.failed", error: { message: "private upstream detail" } }),
    ])).toThrow("Codex result unavailable");
  });
});
