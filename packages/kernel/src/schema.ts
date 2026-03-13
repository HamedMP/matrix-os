import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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

// --- Embeddings table ---

export const embeddings = sqliteTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id"),
    vector: text("vector").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_embeddings_source").on(table.sourceType, table.sourceId),
  ],
);

// --- Social tables ---

export const socialPosts = sqliteTable(
  "social_posts",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").notNull(),
    content: text("content").notNull(),
    type: text("type").notNull(), // text | image | link | app_share | activity
    mediaUrls: text("media_urls"),
    appRef: text("app_ref"),
    parentId: text("parent_id"), // for comments/replies
    likesCount: integer("likes_count").default(0).notNull(),
    commentsCount: integer("comments_count").default(0).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_posts_author").on(table.authorId),
    index("idx_posts_type").on(table.type),
    index("idx_posts_created").on(table.createdAt),
    index("idx_posts_likes").on(table.likesCount),
    index("idx_posts_parent").on(table.parentId),
  ],
);

export const socialLikes = sqliteTable(
  "social_likes",
  {
    postId: text("post_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_likes_post_user").on(table.postId, table.userId),
  ],
);

export const socialFollows = sqliteTable(
  "social_follows",
  {
    followerId: text("follower_id").notNull(),
    followeeId: text("followee_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_follows_pair").on(table.followerId, table.followeeId),
    index("idx_follows_follower").on(table.followerId),
    index("idx_follows_followee").on(table.followeeId),
  ],
);

export type SocialPost = typeof socialPosts.$inferSelect;
export type SocialLike = typeof socialLikes.$inferSelect;
export type SocialFollow = typeof socialFollows.$inferSelect;
