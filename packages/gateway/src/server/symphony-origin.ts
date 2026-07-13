import { SymphonyConfigLoadError } from "../symphony-runner.js";

export interface SymphonyConfigReader {
  getConfig(): Promise<{ port?: number }>;
}

export async function readInitialSymphonyPort(runner: SymphonyConfigReader): Promise<number | undefined> {
  try {
    return (await runner.getConfig()).port;
  } catch (err: unknown) {
    if (err instanceof SymphonyConfigLoadError) {
      console.warn("[gateway] Ignoring invalid Symphony config while seeding CORS origins");
      return undefined;
    }
    throw err;
  }
}

function parseSymphonyPort(value: string | undefined): number | undefined {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}

function parseLoopbackOriginPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return undefined;
    }
    return parseSymphonyPort(url.port);
  } catch (err: unknown) {
    if (!(err instanceof TypeError)) {
      console.warn("[gateway] Ignoring invalid Symphony upstream origin:", err);
    }
    return undefined;
  }
}

export async function resolveInitialSymphonyPort(
  runner: SymphonyConfigReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | undefined> {
  return parseLoopbackOriginPort(env.SYMPHONY_UPSTREAM_ORIGIN) ??
    parseSymphonyPort(env.SYMPHONY_PORT) ??
    await readInitialSymphonyPort(runner);
}

export function symphonyUpstreamOriginForPort(port: number | undefined): string | undefined {
  return port ? `http://127.0.0.1:${port}` : undefined;
}
