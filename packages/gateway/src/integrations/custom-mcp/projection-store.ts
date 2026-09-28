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
  // Counts pushed writes as they are queued, so a pull can tell whether a
  // push overtook the list it fetched.
  private pushedWrites = 0;

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

  writeGeneration(): number {
    return this.pushedWrites;
  }

  async upsert(server: CustomMcpServerProjection): Promise<void> {
    this.pushedWrites += 1;
    await this.mutate(async (file) => {
      const existingIndex = file.servers.findIndex((entry) => entry.id === server.id);
      // Pushes and startup pulls can arrive out of order; never regress a server.
      if (existingIndex !== -1 && file.servers[existingIndex]!.revision > server.revision) return;
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
    this.pushedWrites += 1;
    await this.mutate(async (file) => {
      file.servers = file.servers.filter((server) => server.id !== serverId);
    });
  }

  /**
   * Replaces every server with a list the platform returned, unless a push was
   * queued after `generation` was read: that push may be newer than the list,
   * so the caller pulls again instead. Returns whether the list was applied.
   */
  async replaceFromPull(servers: CustomMcpServerProjection[], generation: number): Promise<boolean> {
    if (servers.length > MAX_SERVERS) throw new Error("Custom MCP server limit reached");
    return this.mutate(async (file) => {
      if (this.pushedWrites !== generation) return false;
      file.servers = structuredClone(servers).sort((left, right) => left.id.localeCompare(right.id));
    });
  }

  private async mutate(
    operation: (file: CustomMcpProjectionFile) => Promise<void | false>,
  ): Promise<boolean> {
    const previous = this.mutationQueue.catch((error: unknown) => {
      console.warn(
        "[custom-mcp] previous projection mutation failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
    const next = previous.then(async () => {
      const file = await this.read();
      if (await operation(file) === false) return false;
      await atomicWriteJson(this.path, file);
      return true;
    });
    this.mutationQueue = next.then(() => undefined);
    return next;
  }
}
