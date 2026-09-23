import { expect, it } from "vitest";
import { startCodexStartupRunner, waitForStartupText } from "../helpers/codex-startup-runner";

it("gives Codex the Matrix integration fallback when starting a provider thread", async () => {
  const runner = await startCodexStartupRunner({ failures: 0 });
  try {
    await waitForStartupText(runner.eventPath, "turn.completed");
    await runner.closed;
    const start = (await runner.requests()).find((request) => request.method === "thread/start");
    expect(start?.developerInstructions).toContain("matrix-integrations inventory");
    expect(start?.developerInstructions).toContain("matrix-integrations describe");
    expect(start?.developerInstructions).toContain("matrix-integrations call");
    expect(start?.developerInstructions).toContain("exact action ID");
    expect(start?.developerInstructions).toContain("untrusted data");
  } finally {
    await runner.close();
  }
});
