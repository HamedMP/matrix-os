import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDB, type MatrixDB } from "../../packages/kernel/src/db.js";
import { tasks, messages } from "../../packages/kernel/src/schema.js";

describe("Drizzle schema", () => {
  let db: MatrixDB;

  beforeEach(() => {
    db = createDB();
  });

  describe("tasks table", () => {
    const sampleTask = {
      id: "task-1",
      type: "build",
      input: JSON.stringify({ request: "Build a todo app" }),
      createdAt: new Date(),
    };

    it("inserts and retrieves a task", async () => {
      await db.insert(tasks).values(sampleTask);
      const rows = await db.select().from(tasks);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("task-1");
      expect(rows[0].type).toBe("build");
      expect(rows[0].status).toBe("pending");
      expect(rows[0].priority).toBe(0);
    });

    it("defaults status to pending", async () => {
      await db.insert(tasks).values(sampleTask);
      const [row] = await db.select().from(tasks).where(eq(tasks.id, "task-1"));

      expect(row.status).toBe("pending");
    });

    it("updates task status and assigned_to", async () => {
      await db.insert(tasks).values(sampleTask);
      await db
        .update(tasks)
        .set({ status: "in_progress", assignedTo: "builder", claimedAt: new Date() })
        .where(eq(tasks.id, "task-1"));

      const [row] = await db.select().from(tasks).where(eq(tasks.id, "task-1"));
      expect(row.status).toBe("in_progress");
      expect(row.assignedTo).toBe("builder");
      expect(row.claimedAt).toBeInstanceOf(Date);
    });

    it("completes a task with output", async () => {
      await db.insert(tasks).values(sampleTask);
      const output = JSON.stringify({ files: ["todo.html"], entryPoint: "todo.html" });
      await db
        .update(tasks)
        .set({ status: "completed", output, completedAt: new Date() })
        .where(eq(tasks.id, "task-1"));

      const [row] = await db.select().from(tasks).where(eq(tasks.id, "task-1"));
      expect(row.status).toBe("completed");
      expect(JSON.parse(row.output!)).toEqual({
        files: ["todo.html"],
        entryPoint: "todo.html",
      });
    });

    it("deletes a task", async () => {
      await db.insert(tasks).values(sampleTask);
      await db.delete(tasks).where(eq(tasks.id, "task-1"));

      const rows = await db.select().from(tasks);
      expect(rows).toHaveLength(0);
    });

    it("stores depends_on as JSON string", async () => {
      await db.insert(tasks).values({
        ...sampleTask,
        dependsOn: JSON.stringify(["task-0"]),
      });
      const [row] = await db.select().from(tasks).where(eq(tasks.id, "task-1"));
      expect(JSON.parse(row.dependsOn!)).toEqual(["task-0"]);
    });

    it("filters by status index", async () => {
      await db.insert(tasks).values([
        { ...sampleTask, id: "t1", status: "pending" },
        { ...sampleTask, id: "t2", status: "in_progress" },
        { ...sampleTask, id: "t3", status: "completed" },
      ]);

      const pending = await db
        .select()
        .from(tasks)
        .where(eq(tasks.status, "pending"));
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe("t1");
    });
  });

  describe("messages table", () => {
    const sampleMessage = {
      fromAgent: "builder",
      toAgent: "kernel",
      content: "Build complete",
      createdAt: new Date(),
    };

    it("inserts and retrieves a message with auto-increment id", async () => {
      await db.insert(messages).values(sampleMessage);
      const rows = await db.select().from(messages);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].fromAgent).toBe("builder");
      expect(rows[0].toAgent).toBe("kernel");
      expect(rows[0].read).toBe(0);
    });

    it("marks messages as read", async () => {
      await db.insert(messages).values(sampleMessage);
      await db.update(messages).set({ read: 1 }).where(eq(messages.id, 1));

      const [row] = await db.select().from(messages).where(eq(messages.id, 1));
      expect(row.read).toBe(1);
    });

    it("filters unread messages for an agent", async () => {
      await db.insert(messages).values([
        { ...sampleMessage, toAgent: "kernel", content: "msg1" },
        { ...sampleMessage, toAgent: "kernel", content: "msg2", read: 1 },
        { ...sampleMessage, toAgent: "builder", content: "msg3" },
      ]);

      const unread = await db
        .select()
        .from(messages)
        .where(eq(messages.toAgent, "kernel"));
      const unreadOnly = unread.filter((m) => m.read === 0);
      expect(unreadOnly).toHaveLength(1);
      expect(unreadOnly[0].content).toBe("msg1");
    });

    it("deletes messages", async () => {
      await db.insert(messages).values(sampleMessage);
      await db.delete(messages).where(eq(messages.id, 1));
      const rows = await db.select().from(messages);
      expect(rows).toHaveLength(0);
    });
  });

  describe("database setup", () => {
    it("creates tables on initialization", async () => {
      const freshDb = createDB();
      const taskRows = await freshDb.select().from(tasks);
      const msgRows = await freshDb.select().from(messages);
      expect(taskRows).toHaveLength(0);
      expect(msgRows).toHaveLength(0);
    });

    it("is idempotent (can create twice without error)", () => {
      expect(() => createDB()).not.toThrow();
      expect(() => createDB()).not.toThrow();
    });
  });
});
