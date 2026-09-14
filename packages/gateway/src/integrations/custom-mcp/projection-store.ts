import { join } from "node:path";
import { atomicWriteJson, readJsonFile } from "../../state-ops.js";
import type {
  CustomMcpProjectionFile,
  CustomMcpServerProjection,
} from "./types.js";

const EMPTY_PROJECTION: CustomMcpProjectionFile = { version: 1, servers: [] };
const MAX_SERVERS = 20;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class CustomMcpProjectionStore {
  readonly path: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(homePath: string) {
    this.path = join(homePath, "system", "mcp-servers.json");
  }

  async read(): Promise<CustomMcpProjectionFile> {
    try {
      const value = await readJsonFile<CustomMcpProjectionFile>(this.path);
      if (value.version !== 1 || !Array.isArray(value.servers)) {
        throw new Error("Unsupported Custom MCP projection version");
      }
      return value;
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(EMPTY_PROJECTION);
      throw error;
    }
  }

  async upsert(server: CustomMcpServerProjection): Promise<void> {
    return this.mutate(async (file) => {
      const existingIndex = file.servers.findIndex((entry) => entry.id === server.id);
      if (existingIndex === -1 && file.servers.length >= MAX_SERVERS) {
        throw new Error("Custom MCP server limit reached");
      }
      const safeServer = structuredClone(server);
      if (existingIndex === -1) file.servers.push(safeServer);
      else file.servers[existingIndex] = safeServer;
      file.servers.sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  async remove(serverId: string): Promise<void> {
    return this.mutate(async (file) => {
      file.servers = file.servers.filter((server) => server.id !== serverId);
    });
  }

  private async mutate(
    operation: (file: CustomMcpProjectionFile) => Promise<void>,
  ): Promise<void> {
    const previous = this.mutationQueue.catch((error: unknown) => {
      console.warn(
        "[custom-mcp] previous projection mutation failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
    const next = previous.then(async () => {
      const file = await this.read();
      await operation(file);
      await atomicWriteJson(this.path, file);
    });
    this.mutationQueue = next;
    return next;
  }
}
