import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";

interface AppDataParams {
  action: "read" | "write" | "list";
  app: string;
  key?: string;
  value?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** @deprecated File-based handler. Gateway now uses Postgres via KvStore/QueryEngine when DATABASE_URL is set. */
export async function appDataHandler(
  homePath: string,
  params: AppDataParams,
): Promise<ToolResult> {
  const safeApp = sanitize(params.app);
  const dataDir = join(homePath, "data", safeApp);

  if (params.action === "list") {
    if (!existsSync(dataDir)) {
      return { content: [{ type: "text", text: JSON.stringify([]) }] };
    }
    const files = readdirSync(dataDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    return { content: [{ type: "text", text: JSON.stringify(files) }] };
  }

  if (!params.key) {
    return {
      content: [{ type: "text", text: `Error: key is required for ${params.action} action` }],
    };
  }

  const safeKey = sanitize(params.key);
  const filePath = normalize(join(dataDir, `${safeKey}.json`));

  // Path traversal check
  if (!filePath.startsWith(normalize(dataDir))) {
    return { content: [{ type: "text", text: "Error: path traversal denied" }] };
  }

  if (params.action === "read") {
    if (!existsSync(filePath)) {
      return {
        content: [
          { type: "text", text: `No data found for app "${safeApp}" key "${safeKey}"` },
        ],
      };
    }
    const content = readFileSync(filePath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  }

  // write
  if (params.value === undefined || params.value === null) {
    return {
      content: [{ type: "text", text: "Error: value is required for write action" }],
    };
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(filePath, params.value, "utf-8");
  return {
    content: [
      { type: "text", text: `Written ${safeKey} for app "${safeApp}" (${params.value.length} bytes)` },
    ],
  };
}
