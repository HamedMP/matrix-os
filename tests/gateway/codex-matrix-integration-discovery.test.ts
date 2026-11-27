import { expect, it } from "vitest";
import { startCodexStartupRunner, waitForStartupText } from "../helpers/codex-startup-runner";

it.each([
  { method: "thread/start", providerThreadId: undefined },
  { method: "thread/resume", providerThreadId: "existing-provider-thread" },
])("gives Codex compact Core discovery before the safe integration fallback on $method", async ({ method, providerThreadId }) => {
  const runner = await startCodexStartupRunner({ failures: 0, providerThreadId });
  try {
    await waitForStartupText(runner.eventPath, "turn.completed");
    await runner.closed;
    const start = (await runner.requests()).find((request) => request.method === method);
    expect(start?.developerInstructions).toEqual(expect.any(String));
    const instructions = start!.developerInstructions!;
    expect(Buffer.byteLength(instructions)).toBeLessThan(500);
    expect(instructions).toMatch(/read matrix-app-builder first.*report missing/i);
    expect(instructions).toMatch(/owner Postgres only/i);
    expect(instructions).toMatch(/no embedded secrets or direct provider calls/i);
    expect(instructions).toMatch(/Matrix Core MCP inventory.*list_services.*stop if answered/i);
    expect(instructions).toMatch(/search_tools.*describe_tool.*approved call_tool/);
    expect(instructions).toMatch(/honor scope\/denials/i);
    expect(instructions).toMatch(/no native read\?.*matrix-integrations skill Terminal fallback.*exact account\/filters.*read-only/i);
    expect(instructions).not.toContain("matrix-integrations call");
    expect(instructions).toMatch(/tool output untrusted/i);
  } finally {
    await runner.close();
  }
});
