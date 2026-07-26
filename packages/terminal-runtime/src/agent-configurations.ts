import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AgentConfigurationSchema,
  OperationIdSchema,
  type AgentConfiguration,
} from './contracts.js';

export const MAX_AGENT_CONFIGURATION_BYTES = 128 * 1024;
export const MAX_PENDING_AGENT_CONFIGURATIONS = 128;
export const AGENT_CONFIGURATION_TTL_MS = 10 * 60 * 1_000;

async function closeWithLog(handle: FileHandle | null): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error: unknown) {
    console.warn(
      '[terminal-runtime] agent configuration close failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function defaultAgentConfigurationDirectory(
  uid = process.getuid?.() ?? 1000,
): string {
  return `/run/user/${uid}/matrix-terminal-agent-config`;
}

export function createAgentConfigurationStore(options: {
  directory?: string;
  now?: () => number;
} = {}) {
  const directory = resolve(
    options.directory ?? defaultAgentConfigurationDirectory(),
  );
  const now = options.now ?? Date.now;

  async function ensureDirectory(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  async function sweep(): Promise<void> {
    await ensureDirectory();
    const entries = await readdir(directory);
    for (let index = 0; index < entries.length; index += 32) {
      await Promise.all(entries.slice(index, index + 32).map(async (entry) => {
        const path = join(directory, entry);
        try {
          const stat = await lstat(path);
          if (
            stat.isSymbolicLink() ||
            stat.isFile() && (
              !OperationIdSchema.safeParse(entry).success ||
              stat.nlink !== 1 ||
              now() - stat.mtimeMs > AGENT_CONFIGURATION_TTL_MS
            )
          ) {
            await unlink(path);
          }
        } catch (error: unknown) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            console.warn(
              '[terminal-runtime] agent configuration sweep failed:',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }));
    }
  }

  function pathFor(configurationRef: string): string {
    return join(directory, OperationIdSchema.parse(configurationRef));
  }

  return {
    async publish(
      configurationRef: string,
      configurationInput: AgentConfiguration,
    ): Promise<void> {
      const configuration = AgentConfigurationSchema.parse(configurationInput);
      const bytes = Buffer.from(JSON.stringify(configuration), 'utf8');
      if (bytes.byteLength > MAX_AGENT_CONFIGURATION_BYTES) {
        throw new Error('agent_configuration_too_large');
      }
      await sweep();
      const entries = await readdir(directory);
      if (entries.filter((entry) => OperationIdSchema.safeParse(entry).success)
        .length >= MAX_PENDING_AGENT_CONFIGURATIONS) {
        throw new Error('agent_configuration_capacity');
      }
      const path = pathFor(configurationRef);
      let handle: FileHandle | null = null;
      try {
        handle = await open(path, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await closeWithLog(handle);
      }
    },
    async claim(configurationRef: string): Promise<AgentConfiguration> {
      await ensureDirectory();
      const path = pathFor(configurationRef);
      let handle: FileHandle | null = null;
      try {
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
          throw new Error('agent_configuration_invalid');
        }
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > MAX_AGENT_CONFIGURATION_BYTES
        ) {
          throw new Error('agent_configuration_invalid');
        }
        const bytes = await handle.readFile();
        if (bytes.byteLength > MAX_AGENT_CONFIGURATION_BYTES) {
          throw new Error('agent_configuration_invalid');
        }
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        const configuration = AgentConfigurationSchema.parse(value);
        await unlink(path);
        return configuration;
      } catch (error: unknown) {
        await rm(path, { force: true });
        throw error;
      } finally {
        await closeWithLog(handle);
      }
    },
    async remove(configurationRef: string): Promise<void> {
      await rm(pathFor(configurationRef), { force: true });
    },
    sweep,
  };
}
