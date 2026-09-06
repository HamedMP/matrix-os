import { defineCommand } from "citty";
import {
  composeArgs,
  createOrUpdateDevInstance,
  defaultCommandRunner,
  loadDevInstance,
  loadDevInstances,
  removeDevInstanceFiles,
  saveDevInstance,
  type CommandRunner,
  type DevInstance,
} from "../dev-workspaces.js";
import { formatCliError, formatCliSuccess } from "../output.js";

const DEV_USAGE = "Usage: mos dev up|list|open|logs|stop|rm|expose";
const DEV_SUBCOMMANDS = new Set(["up", "list", "ls", "open", "logs", "stop", "rm", "remove", "expose", "unexpose"]);
const DEV_VALUE_OPTIONS = new Set(["--path", "--name", "--tail", "--profile", "--gateway", "--token"]);

const commonArgs = {
  json: { type: "boolean", required: false, default: false },
  home: { type: "string", required: false },
} as const;

function hasDevSubCommand(rawArgs: string[] | undefined): boolean {
  if (!Array.isArray(rawArgs)) return false;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg.startsWith("--")) {
      const [option] = arg.split("=", 1);
      if (DEV_VALUE_OPTIONS.has(option) && !arg.includes("=")) i += 1;
      continue;
    }
    return DEV_SUBCOMMANDS.has(arg);
  }
  return false;
}

function codeFromError(err: unknown): string {
  return err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : "dev_request_failed";
}

function writeError(err: unknown, json: boolean): void {
  const code = codeFromError(err);
  const message = err instanceof Error ? err.message : undefined;
  console.error(json ? formatCliError(code, message) : `Error: ${message ?? code}`);
}

function publicInstance(instance: DevInstance): Record<string, unknown> {
  return {
    name: instance.name,
    repoPath: instance.repoPath,
    status: instance.status,
    exposure: instance.exposure,
    projectName: instance.projectName,
    shellUrl: `http://127.0.0.1:${instance.shellPort}`,
    gatewayUrl: `http://127.0.0.1:${instance.gatewayPort}`,
    shellPort: instance.shellPort,
    gatewayPort: instance.gatewayPort,
    updatedAt: instance.updatedAt,
  };
}

function homeDirFromArgs(args: Record<string, unknown>): string | undefined {
  return typeof args.home === "string" ? args.home : undefined;
}

function runnerFromArgs(args: Record<string, unknown>): CommandRunner {
  return typeof args.commandRunner === "function" ? args.commandRunner as CommandRunner : defaultCommandRunner;
}

async function runWithErrors(args: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err: unknown) {
    writeError(err, args.json === true);
    process.exitCode = 1;
  }
}

async function runUp(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  await runWithErrors(args, async () => {
    const repoPath = typeof args.path === "string" ? args.path : process.cwd();
    const instance = await createOrUpdateDevInstance({
      repoPath,
      name: typeof args.name === "string" ? args.name : undefined,
      homeDir: homeDirFromArgs(args),
    });
    const extra = args.build === true ? ["--build"] : [];
    await runnerFromArgs(args)("docker", composeArgs(instance, "up", extra), { cwd: instance.repoPath, stdio: "inherit" });
    const running = { ...instance, status: "running" as const, updatedAt: new Date().toISOString() };
    await saveDevInstance(running);
    const data = publicInstance(running);
    console.log(json ? formatCliSuccess(data) : `Started ${running.name}\nShell:   ${data.shellUrl}\nGateway: ${data.gatewayUrl}`);
  });
}

async function runList(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  await runWithErrors(args, async () => {
    const instances = (await loadDevInstances(homeDirFromArgs(args))).map(publicInstance);
    if (json) {
      console.log(formatCliSuccess({ instances }));
      return;
    }
    if (instances.length === 0) {
      console.log("No dev instances.");
      return;
    }
    for (const instance of instances) {
      console.log(`${instance.name}\t${instance.status}\t${instance.shellUrl}\t${instance.gatewayUrl}`);
    }
  });
}

async function instanceFromArgs(args: Record<string, unknown>): Promise<DevInstance> {
  if (typeof args.name !== "string") {
    throw Object.assign(new Error("Missing dev instance name."), { code: "invalid_request" });
  }
  return loadDevInstance(args.name, homeDirFromArgs(args));
}

async function runOpen(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  await runWithErrors(args, async () => {
    const instance = await instanceFromArgs(args);
    const data = publicInstance(instance);
    console.log(json ? formatCliSuccess(data) : `${data.shellUrl}`);
  });
}

async function runLogs(args: Record<string, unknown>): Promise<void> {
  await runWithErrors(args, async () => {
    const instance = await instanceFromArgs(args);
    const tail = typeof args.tail === "string" && /^\d+$/.test(args.tail) ? args.tail : "120";
    const extra = ["--tail", tail];
    if (args.follow === true) extra.push("-f");
    await runnerFromArgs(args)("docker", composeArgs(instance, "logs", extra), { cwd: instance.repoPath, stdio: "inherit" });
  });
}

async function runStop(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  await runWithErrors(args, async () => {
    const instance = await instanceFromArgs(args);
    await runnerFromArgs(args)("docker", composeArgs(instance, "stop"), { cwd: instance.repoPath, stdio: "inherit" });
    const stopped = { ...instance, status: "stopped" as const, updatedAt: new Date().toISOString() };
    await saveDevInstance(stopped);
    console.log(json ? formatCliSuccess(publicInstance(stopped)) : `Stopped ${stopped.name}`);
  });
}

async function runRemove(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  await runWithErrors(args, async () => {
    const instance = await instanceFromArgs(args);
    await runnerFromArgs(args)("docker", composeArgs(instance, "down", ["--volumes", "--remove-orphans"]), { cwd: instance.repoPath, stdio: "inherit" });
    await removeDevInstanceFiles(instance);
    console.log(json ? formatCliSuccess({ name: instance.name, removed: true }) : `Removed ${instance.name}`);
  });
}

async function runStretch(args: Record<string, unknown>): Promise<void> {
  writeError(Object.assign(new Error("Public preview is a stretch goal and is not implemented in local-only mos dev."), { code: "not_implemented" }), args.json === true);
  process.exitCode = 1;
}

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Manage local Matrix OS contributor workspaces",
  },
  args: commonArgs,
  subCommands: {
    up: defineCommand({
      meta: { name: "up", description: "Start or reconcile a local Matrix OS dev workspace" },
      args: {
        path: { type: "string", required: false },
        name: { type: "string", required: false },
        build: { type: "boolean", required: false, default: false },
        ...commonArgs,
      },
      run: async ({ args }) => runUp(args),
    }),
    list: defineCommand({
      meta: { name: "list", description: "List local Matrix OS dev workspaces" },
      args: commonArgs,
      run: async ({ args }) => runList(args),
    }),
    ls: defineCommand({
      meta: { name: "ls", description: "List local Matrix OS dev workspaces" },
      args: commonArgs,
      run: async ({ args }) => runList(args),
    }),
    open: defineCommand({
      meta: { name: "open", description: "Print the local shell URL for a dev workspace" },
      args: { name: { type: "positional", required: true }, ...commonArgs },
      run: async ({ args }) => runOpen(args),
    }),
    logs: defineCommand({
      meta: { name: "logs", description: "Show Docker compose logs for a dev workspace" },
      args: {
        name: { type: "positional", required: true },
        tail: { type: "string", required: false },
        follow: { type: "boolean", required: false, default: false },
        ...commonArgs,
      },
      run: async ({ args }) => runLogs(args),
    }),
    stop: defineCommand({
      meta: { name: "stop", description: "Stop a local Matrix OS dev workspace" },
      args: { name: { type: "positional", required: true }, ...commonArgs },
      run: async ({ args }) => runStop(args),
    }),
    rm: defineCommand({
      meta: { name: "rm", description: "Remove a local Matrix OS dev workspace and volumes" },
      args: { name: { type: "positional", required: true }, ...commonArgs },
      run: async ({ args }) => runRemove(args),
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Remove a local Matrix OS dev workspace and volumes" },
      args: { name: { type: "positional", required: true }, ...commonArgs },
      run: async ({ args }) => runRemove(args),
    }),
    expose: defineCommand({
      meta: { name: "expose", description: "Public preview stretch goal placeholder" },
      args: { name: { type: "positional", required: true }, ...commonArgs },
      run: async ({ args }) => runStretch(args),
    }),
    unexpose: defineCommand({
      meta: { name: "unexpose", description: "Public preview stretch goal placeholder" },
      args: { name: { type: "positional", required: true }, ...commonArgs },
      run: async ({ args }) => runStretch(args),
    }),
  },
  run: ({ rawArgs }) => {
    if (!hasDevSubCommand(rawArgs)) {
      console.log(DEV_USAGE);
    }
  },
});
