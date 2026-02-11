import { eq, and, sql } from "drizzle-orm";
import { tasks, messages } from "./schema.js";
import type { MatrixDB } from "./db.js";

export function createTask(
  db: MatrixDB,
  opts: { type: string; input: unknown; priority?: number; dependsOn?: string[] },
): string {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.insert(tasks)
    .values({
      id,
      type: opts.type,
      input: JSON.stringify(opts.input),
      priority: opts.priority ?? 0,
      dependsOn: opts.dependsOn ? JSON.stringify(opts.dependsOn) : null,
      createdAt: new Date(),
    })
    .run();
  return id;
}

export function listTasks(
  db: MatrixDB,
  filter?: { status?: string; assignedTo?: string },
) {
  let query = db.select().from(tasks);

  if (filter?.status && filter?.assignedTo) {
    query = query.where(
      and(eq(tasks.status, filter.status), eq(tasks.assignedTo, filter.assignedTo)),
    ) as typeof query;
  } else if (filter?.status) {
    query = query.where(eq(tasks.status, filter.status)) as typeof query;
  } else if (filter?.assignedTo) {
    query = query.where(eq(tasks.assignedTo, filter.assignedTo)) as typeof query;
  }

  return query.all();
}

export function claimTask(
  db: MatrixDB,
  taskId: string,
  agentName: string,
): { success: boolean } {
  const result = db
    .update(tasks)
    .set({
      status: "in_progress",
      assignedTo: agentName,
      claimedAt: new Date(),
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "pending")))
    .run();

  return { success: result.changes > 0 };
}

export function completeTask(
  db: MatrixDB,
  taskId: string,
  output: unknown,
): { success: boolean } {
  const result = db
    .update(tasks)
    .set({
      status: "completed",
      output: JSON.stringify(output),
      completedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .run();

  return { success: result.changes > 0 };
}

export function failTask(
  db: MatrixDB,
  taskId: string,
  error: string,
): { success: boolean } {
  const result = db
    .update(tasks)
    .set({
      status: "failed",
      output: JSON.stringify({ error }),
      completedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .run();

  return { success: result.changes > 0 };
}

export function sendMessage(
  db: MatrixDB,
  opts: { from: string; to: string; content: string },
) {
  db.insert(messages)
    .values({
      fromAgent: opts.from,
      toAgent: opts.to,
      content: opts.content,
      createdAt: new Date(),
    })
    .run();
}

export function readMessages(db: MatrixDB, agentName: string) {
  const unread = db
    .select()
    .from(messages)
    .where(and(eq(messages.toAgent, agentName), eq(messages.read, 0)))
    .all();

  if (unread.length > 0) {
    db.update(messages)
      .set({ read: 1 })
      .where(and(eq(messages.toAgent, agentName), eq(messages.read, 0)))
      .run();
  }

  return unread;
}

export function readState(db: MatrixDB): string {
  const counts = db
    .select({
      status: tasks.status,
      count: sql<number>`count(*)`,
    })
    .from(tasks)
    .groupBy(tasks.status)
    .all();

  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const lines = [
    `Tasks: ${total} total`,
    ...counts.map((c) => `  ${c.status}: ${c.count}`),
  ];

  const unreadCount = db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.read, 0))
    .get();

  lines.push(`Unread messages: ${unreadCount?.count ?? 0}`);

  return lines.join("\n");
}
