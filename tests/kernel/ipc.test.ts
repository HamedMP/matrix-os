import { describe, it, expect, beforeEach } from "vitest";
import { createDB, type MatrixDB } from "../../packages/kernel/src/db.js";
import {
  listTasks,
  getTask,
  claimTask,
  completeTask,
  failTask,
  sendMessage,
  readMessages,
  readState,
  createTask,
} from "../../packages/kernel/src/ipc.js";

describe("IPC tools", () => {
  let db: MatrixDB;

  beforeEach(() => {
    db = createDB();
  });

  describe("createTask", () => {
    it("creates a task and returns its id", () => {
      const id = createTask(db, {
        type: "build",
        input: { request: "Build a todo app" },
      });
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe("listTasks", () => {
    it("returns empty array when no tasks exist", () => {
      const result = listTasks(db);
      expect(result).toEqual([]);
    });

    it("returns all tasks", () => {
      createTask(db, { type: "build", input: { request: "app1" } });
      createTask(db, { type: "research", input: { request: "find info" } });
      const result = listTasks(db);
      expect(result).toHaveLength(2);
    });

    it("filters by status", () => {
      const id1 = createTask(db, { type: "build", input: { request: "app1" } });
      createTask(db, { type: "build", input: { request: "app2" } });
      claimTask(db, id1, "builder");

      const pending = listTasks(db, { status: "pending" });
      expect(pending).toHaveLength(1);

      const inProgress = listTasks(db, { status: "in_progress" });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].id).toBe(id1);
    });

    it("filters by assignee", () => {
      const id1 = createTask(db, { type: "build", input: { request: "app1" } });
      createTask(db, { type: "build", input: { request: "app2" } });
      claimTask(db, id1, "builder");

      const builderTasks = listTasks(db, { assignedTo: "builder" });
      expect(builderTasks).toHaveLength(1);
      expect(builderTasks[0].assignedTo).toBe("builder");
    });
  });

  describe("getTask", () => {
    it("returns a task by ID", () => {
      const id = createTask(db, { type: "build", input: { request: "app1" } });
      const task = getTask(db, id);
      expect(task).toBeDefined();
      expect(task!.id).toBe(id);
      expect(task!.type).toBe("build");
      expect(task!.status).toBe("pending");
    });

    it("returns undefined for missing task", () => {
      const task = getTask(db, "nonexistent");
      expect(task).toBeUndefined();
    });

    it("includes all task fields after claim and complete", () => {
      const id = createTask(db, { type: "build", input: { request: "app" } });
      claimTask(db, id, "builder");
      completeTask(db, id, { files: ["app.html"] });

      const task = getTask(db, id);
      expect(task!.status).toBe("completed");
      expect(task!.assignedTo).toBe("builder");
      expect(task!.claimedAt).toBeInstanceOf(Date);
      expect(task!.completedAt).toBeInstanceOf(Date);
      expect(JSON.parse(task!.output!)).toEqual({ files: ["app.html"] });
    });
  });

  describe("claimTask", () => {
    it("claims an unassigned pending task", () => {
      const id = createTask(db, { type: "build", input: { request: "app" } });
      const result = claimTask(db, id, "builder");
      expect(result.success).toBe(true);

      const [task] = listTasks(db, { status: "in_progress" });
      expect(task.assignedTo).toBe("builder");
      expect(task.status).toBe("in_progress");
    });

    it("prevents double-claiming (atomic)", () => {
      const id = createTask(db, { type: "build", input: { request: "app" } });
      const first = claimTask(db, id, "builder");
      const second = claimTask(db, id, "researcher");

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
    });

    it("rejects claiming a non-existent task", () => {
      const result = claimTask(db, "nonexistent", "builder");
      expect(result.success).toBe(false);
    });
  });

  describe("completeTask", () => {
    it("marks a task as completed with output", () => {
      const id = createTask(db, { type: "build", input: { request: "app" } });
      claimTask(db, id, "builder");

      const output = { files: ["todo.html"], entryPoint: "todo.html" };
      const result = completeTask(db, id, output);
      expect(result.success).toBe(true);

      const [task] = listTasks(db, { status: "completed" });
      expect(task.id).toBe(id);
      expect(JSON.parse(task.output!)).toEqual(output);
      expect(task.completedAt).toBeInstanceOf(Date);
    });
  });

  describe("failTask", () => {
    it("marks a task as failed with error", () => {
      const id = createTask(db, { type: "build", input: { request: "app" } });
      claimTask(db, id, "builder");

      const result = failTask(db, id, "Build failed: syntax error");
      expect(result.success).toBe(true);

      const [task] = listTasks(db, { status: "failed" });
      expect(task.id).toBe(id);
      expect(task.output).toContain("syntax error");
    });
  });

  describe("sendMessage", () => {
    it("inserts a message", () => {
      sendMessage(db, { from: "builder", to: "kernel", content: "Done!" });

      const msgs = readMessages(db, "kernel");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("Done!");
      expect(msgs[0].fromAgent).toBe("builder");
    });
  });

  describe("readMessages", () => {
    it("returns unread messages for an agent", () => {
      sendMessage(db, { from: "builder", to: "kernel", content: "msg1" });
      sendMessage(db, { from: "builder", to: "kernel", content: "msg2" });
      sendMessage(db, { from: "builder", to: "researcher", content: "msg3" });

      const msgs = readMessages(db, "kernel");
      expect(msgs).toHaveLength(2);
    });

    it("marks messages as read after reading", () => {
      sendMessage(db, { from: "builder", to: "kernel", content: "msg1" });

      const first = readMessages(db, "kernel");
      expect(first).toHaveLength(1);

      const second = readMessages(db, "kernel");
      expect(second).toHaveLength(0);
    });
  });

  describe("readState", () => {
    it("returns a state summary string", () => {
      createTask(db, { type: "build", input: { request: "app1" } });
      createTask(db, { type: "research", input: { request: "info" } });

      const state = readState(db);
      expect(typeof state).toBe("string");
      expect(state).toContain("2"); // 2 tasks total
    });

    it("includes task counts by status", () => {
      const id = createTask(db, { type: "build", input: { request: "app" } });
      createTask(db, { type: "build", input: { request: "app2" } });
      claimTask(db, id, "builder");

      const state = readState(db);
      expect(state).toContain("pending");
      expect(state).toContain("in_progress");
    });
  });
});
