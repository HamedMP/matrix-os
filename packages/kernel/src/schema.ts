import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status").default("pending").notNull(),
    assignedTo: text("assigned_to"),
    dependsOn: text("depends_on"),
    input: text("input").notNull(),
    output: text("output"),
    priority: integer("priority").default(0).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_assigned").on(table.assignedTo),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromAgent: text("from_agent").notNull(),
    toAgent: text("to_agent").notNull(),
    content: text("content").notNull(),
    read: integer("read").default(0).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("idx_messages_to").on(table.toAgent, table.read)],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    source: text("source"),
    category: text("category").default("fact"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  },
);
