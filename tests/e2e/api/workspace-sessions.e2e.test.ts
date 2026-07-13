import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("workspace session routing", () => {
  let gateway: TestGateway;

  beforeAll(async () => {
    gateway = await startTestGateway();
  });

  afterAll(async () => {
    await gateway.close();
  });

  it("routes task session creation to the workspace API instead of the legacy terminal API", async () => {
    const response = await gateway.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "shell", projectSlug: "missing", taskId: "task_missing" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });
});
