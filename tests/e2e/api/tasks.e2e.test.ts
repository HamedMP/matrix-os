import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Task Management", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("POST /api/tasks creates a task and returns 201", async () => {
    const res = await fetch(`${gw.url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Buy groceries" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.task).toBeDefined();
    expect(body.task.type).toBe("todo");
    expect(body.task.status).toBe("pending");
    expect(body.task.input).toBe(JSON.stringify("Buy groceries"));
  });

  it("POST /api/tasks with type and priority", async () => {
    const res = await fetch(`${gw.url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Deploy app", type: "deploy", priority: 1 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.task.type).toBe("deploy");
    expect(body.task.priority).toBe(1);
  });

  it("GET /api/tasks lists all tasks", async () => {
    const res = await fetch(`${gw.url}/api/tasks`);
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/tasks?status=pending filters by status", async () => {
    const res = await fetch(`${gw.url}/api/tasks?status=pending`);
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);
    for (const task of tasks) {
      expect(task.status).toBe("pending");
    }
  });

  it("GET /api/tasks/:id returns a specific task", async () => {
    const createRes = await fetch(`${gw.url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Specific task" }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${gw.url}/api/tasks/${id}`);
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.id).toBe(id);
    expect(task.input).toBe(JSON.stringify("Specific task"));
  });

  it("GET /api/tasks/nonexistent returns 404", async () => {
    const res = await fetch(`${gw.url}/api/tasks/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("POST /api/tasks without input returns 400", async () => {
    const res = await fetch(`${gw.url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("input is required");
  });

  it("task has expected fields", async () => {
    const createRes = await fetch(`${gw.url}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Field check" }),
    });
    const { task } = await createRes.json();
    expect(task).toHaveProperty("id");
    expect(task).toHaveProperty("type");
    expect(task).toHaveProperty("status");
    expect(task).toHaveProperty("input");
    expect(task).toHaveProperty("priority");
    expect(task).toHaveProperty("createdAt");
  });
});
