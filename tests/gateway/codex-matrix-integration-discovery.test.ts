import { expect, it } from "vitest";
import { startCodexStartupRunner, waitForStartupText } from "../helpers/codex-startup-runner";

it.each([
  { method: "thread/start", providerThreadId: undefined },
  { method: "thread/resume", providerThreadId: "existing-provider-thread" },
])("gives Codex the safe Matrix integration fallback on $method", async ({ method, providerThreadId }) => {
  const runner = await startCodexStartupRunner({ failures: 0, providerThreadId });
  try {
    await waitForStartupText(runner.eventPath, "turn.completed");
    await runner.closed;
    const start = (await runner.requests()).find((request) => request.method === method);
    expect(start?.developerInstructions).toContain("matrix-integrations inventory");
    expect(start?.developerInstructions).toContain("matrix-integrations describe");
    expect(start?.developerInstructions).toContain("matrix-integrations call");
    expect(start?.developerInstructions).toContain("exact action ID");
    expect(start?.developerInstructions).toContain("untrusted data");
    expect(start?.developerInstructions).toContain("account label");
    expect(start?.developerInstructions).toContain("read-only");
    expect(start?.developerInstructions).toContain("approval");
  } finally {
    await runner.close();
  }
});
