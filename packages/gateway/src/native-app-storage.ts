import type { AppRegistry, RegisterOpts } from "./app-db-registry.js";

const NATIVE_APP_STORAGE: readonly RegisterOpts[] = [
  {
    slug: "notes",
    name: "Notes",
    description: "Native Matrix OS notes",
    version: "1.0.0",
    author: "system",
    category: "productivity",
    tables: {
      notes: {
        columns: {
          title: "text",
          content: "text",
          content_json: "jsonb",
          pinned: "boolean",
          tags: "text",
        },
        indexes: ["pinned"],
      },
    },
  },
];

/** Provisions storage for native surfaces that have no filesystem app manifest. */
export async function registerNativeAppStorage(registry: AppRegistry): Promise<string[]> {
  const registered: string[] = [];
  for (const definition of NATIVE_APP_STORAGE) {
    try {
      await registry.register(definition);
      registered.push(definition.slug);
    } catch (error) {
      console.error(
        `[app-db] Native storage registration failed for ${definition.slug}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return registered;
}
