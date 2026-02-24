import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Cron + Heartbeat", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("GET /api/cron returns empty list initially", async () => {
    const res = await fetch(`${gw.url}/api/cron`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("POST /api/cron with interval schedule creates job", async () => {
    const res = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-interval",
        message: "interval check",
        schedule: { type: "interval", intervalMs: 60_000 },
      }),
    });
    expect(res.status).toBe(201);
    const job = await res.json();
    expect(job.id).toBeDefined();
    expect(job.name).toBe("test-interval");
    expect(job.message).toBe("interval check");
    expect(job.schedule.type).toBe("interval");
    expect(job.schedule.intervalMs).toBe(60_000);
  });

  it("GET /api/cron lists created jobs", async () => {
    const res = await fetch(`${gw.url}/api/cron`);
    expect(res.status).toBe(200);
    const jobs = await res.json();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const found = jobs.find((j: { name: string }) => j.name === "test-interval");
    expect(found).toBeDefined();
  });

  it("DELETE /api/cron/:id removes the job", async () => {
    // Create a job to delete
    const createRes = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-delete",
        message: "will be deleted",
        schedule: { type: "interval", intervalMs: 30_000 },
      }),
    });
    const job = await createRes.json();

    const delRes = await fetch(`${gw.url}/api/cron/${job.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);

    // Verify it's gone
    const listRes = await fetch(`${gw.url}/api/cron`);
    const jobs = await listRes.json();
    const found = jobs.find((j: { id: string }) => j.id === job.id);
    expect(found).toBeUndefined();
  });

  it("DELETE /api/cron/nonexistent returns 404", async () => {
    const res = await fetch(`${gw.url}/api/cron/nonexistent-id`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/cron with missing fields returns 400", async () => {
    const res = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "incomplete" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/cron with once schedule", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const res = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "one-time",
        message: "run once",
        schedule: { type: "once", at: futureDate },
      }),
    });
    expect(res.status).toBe(201);
    const job = await res.json();
    expect(job.schedule.type).toBe("once");
    expect(job.schedule.at).toBe(futureDate);
  });

  it("POST /api/cron with cron expression", async () => {
    const res = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "cron-expr",
        message: "every hour",
        schedule: { type: "cron", cron: "0 * * * *" },
      }),
    });
    expect(res.status).toBe(201);
    const job = await res.json();
    expect(job.schedule.type).toBe("cron");
    expect(job.schedule.cron).toBe("0 * * * *");
  });

  it("POST /api/cron with invalid schedule type returns 400", async () => {
    const res = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-schedule",
        message: "test",
        schedule: { type: "invalid" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/cron with target", async () => {
    const res = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "targeted",
        message: "hello channel",
        schedule: { type: "interval", intervalMs: 60_000 },
        target: { channel: "telegram", chatId: "123" },
      }),
    });
    expect(res.status).toBe(201);
    const job = await res.json();
    expect(job.target).toEqual({ channel: "telegram", chatId: "123" });
  });

  it("job includes createdAt timestamp", async () => {
    const before = new Date().toISOString();
    const res = await fetch(`${gw.url}/api/cron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "timestamped",
        message: "check time",
        schedule: { type: "interval", intervalMs: 60_000 },
      }),
    });
    const job = await res.json();
    expect(job.createdAt).toBeDefined();
    expect(new Date(job.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime() - 1000,
    );
  });
});
