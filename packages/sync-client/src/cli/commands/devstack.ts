import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import { z } from "zod/v4";
import { openBrowser } from "../../auth/oauth.js";
import { getConfigDir } from "../../lib/config.js";
import { loadProfiles } from "../../lib/profiles.js";
import { cliError, formatCliError, formatCliSuccess } from "../output.js";
import { watchStageThree } from "./devstack-stage3-watch.js";

const exec = promisify(execFile);
const safeText = z.string().min(1).max(4096).refine(value => !/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(value));
const stageThreeSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/).refine(value => !value.includes("\n"));
const computerSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const bindingSchema = z.object({
  computer: computerSchema,
  worktree: safeText.refine(isAbsolute),
});
const bindingsSchema = z.array(bindingSchema).max(100);
type Binding = z.infer<typeof bindingSchema>;

const previewUrlSchema = z.url({ protocol: /^https$/ }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash &&
    /^\/vm\/[a-z0-9][a-z0-9-]*\/?$/.test(url.pathname);
});
const syncSchema = z.object({ syncScope: z.array(safeText).min(1).max(100) });
const previewSchema = syncSchema.extend({ previewUrl: previewUrlSchema });
const statusSchema = z.object({
  state: z.enum(["registered", "syncing", "ready", "conflict", "unavailable"]),
  previewUrl: previewUrlSchema.optional(),
}).refine(status => status.state !== "ready" || status.previewUrl !== undefined);
const diffSchema = z.object({
  changes: z.array(z.object({ path: safeText, status: safeText.max(16) })).max(2000),
  excluded: z.array(safeText).max(2000).optional(),
});
const stageTwoActions = ["connect", "sync", "diff", "status", "reset"] as const;
const actions = [...stageTwoActions, "watch"] as const;
type Action = typeof stageTwoActions[number];

const errors: Record<Action | "list" | "discover" | "enroll", string> = {
  list: "Could not read the enrolled Stage 2 bindings.",
  discover: "Could not discover eligible Stage 2 worktrees.",
  enroll: "Could not enroll the selected Stage 2 worktree.",
  connect: "Could not prepare the authenticated Stage 2 preview.",
  sync: "Could not sync the selected Stage 2 worktree.",
  diff: "Could not read changes in the selected worktree.",
  status: "Could not read the selected Stage 2 binding status.",
  reset: "Could not rebuild the selected Stage 2 source mirror.",
};

// The operator installs an owner-only adapter outside any Git worktree.
async function localAdapter(stage: 2 | 3): Promise<string> {
  const directory = getConfigDir();
  const path = join(directory, stage === 3 ? "devstack-stage3-adapter" : "devstack-adapter");
  try {
    const [parent, stat] = await Promise.all([lstat(directory), lstat(path)]);
    const owner = process.getuid?.();
    if (parent.isDirectory() && parent.uid === owner && (parent.mode & 0o022) === 0 &&
        stat.isFile() && stat.uid === owner && (stat.mode & 0o077) === 0 && (stat.mode & 0o100) !== 0) {
      return path;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw cliError("devstack_adapter_unavailable", `Could not inspect the local Stage ${stage} adapter.`);
    }
  }
  throw cliError("devstack_adapter_unavailable", `A private Stage ${stage} adapter must be enrolled on this computer first.`);
}

type AdapterAction = keyof typeof errors;

async function adapterRequest<T>(
  adapter: string,
  schema: z.ZodType<T>,
  action: AdapterAction,
  ...args: string[]
): Promise<T> {
  const timeout = ["connect", "enroll", "reset", "sync"].includes(action) ? 120_000 : 45_000;
  try {
    const { stdout } = await exec(adapter, [action, ...args], { timeout, maxBuffer: 256 * 1024 });
    return schema.parse(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 78) {
      throw cliError("devstack_capacity_unavailable", "The isolated Stage 2 slot lacks resource headroom.");
    }
    // The original adapter rejects unknown actions with this exact diagnostic.
    // Exit 64 explicitly signals an unsupported action in versioned adapters.
    if (action === "discover" && error instanceof Error && "code" in error &&
        (error.code === 64 || (error.code === 1 && "stderr" in error &&
          typeof error.stderr === "string" && error.stderr.trim() === "This Computer and worktree are not enrolled."))) {
      throw cliError("devstack_discovery_unsupported");
    }
    throw cliError("devstack_adapter_failed", errors[action]);
  }
}

async function discover(adapter: string, worktree?: string): Promise<Binding[]> {
  try {
    return await adapterRequest(adapter, bindingsSchema, "discover", ...(worktree ? [worktree] : []));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "devstack_discovery_unsupported") return [];
    throw error;
  }
}

async function select(label: string, options: string[]): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    options.forEach((option, index) => process.stderr.write(`  ${index + 1}. ${option}\n`));
    const answer = (await prompt.question(`${label} [1-${options.length}]: `)).trim();
    const choice = /^\d+$/.test(answer) ? options[Number(answer) - 1] : undefined;
    if (choice !== undefined) return choice;
    throw cliError("devstack_selection_required", "Choose a listed option and retry.");
  } finally {
    prompt.close();
  }
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    // The adapter remains responsible for confirming the enrolled source exists.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return absolute;
    throw cliError("devstack_selection_required", "Could not resolve the selected worktree path.");
  }
}

async function currentWorktree(): Promise<string> {
  try {
    // Repo overrides must not change which binding a command targets from cwd.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { env, timeout: 5000, maxBuffer: 8192 });
    const worktree = stdout.replace(/\r?\n$/, "");
    if (isAbsolute(worktree)) return await canonicalPath(worktree);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    // An explicit worktree is required when cwd cannot identify the binding.
  }
  throw cliError("devstack_selection_required", "Run from the enrolled worktree or pass --worktree <path>.");
}

function matchingBindings(bindings: Binding[], computer?: string, worktree?: string): Binding[] {
  return bindings.filter(binding =>
    (computer === undefined || binding.computer === computer) &&
    (worktree === undefined || binding.worktree === worktree));
}

function requireMatches(bindings: Binding[], message: string): void {
  if (bindings.length === 0) throw cliError("devstack_binding_not_found", message);
}

async function connect(
  adapter: string,
  bindings: Binding[],
  options: { computer?: string; worktree?: string; interactive: boolean; open?: boolean; json: boolean },
): Promise<void> {
  let { computer, worktree } = options;
  const alreadyBound = computer !== undefined && worktree !== undefined &&
    matchingBindings(bindings, computer, worktree).length > 0;
  const candidates = alreadyBound ? bindings : [...bindings, ...await discover(adapter, worktree)];
  const matching = matchingBindings(candidates, computer, worktree);
  requireMatches(matching, "No eligible Stage 2 binding matches that Computer and worktree.");
  computer ??= await select("Dev Computer", [...new Set(matching.map(binding => binding.computer))]);
  worktree ??= await select("Local worktree", [
    ...new Set(matchingBindings(matching, computer).map(binding => binding.worktree)),
  ]);

  const action = matchingBindings(bindings, computer, worktree).length > 0 ? "connect" : "enroll";
  const browser = (options.open ?? options.interactive) ? "open" : "link";
  const preview = await adapterRequest(adapter, previewSchema, action, computer, worktree, browser);
  if (options.json) {
    console.log(formatCliSuccess({ computer, worktree, ...preview }));
  } else {
    console.log(`Stage 2 preview: ${preview.previewUrl}`);
    console.log(`Synced: ${preview.syncScope.join(", ")}`);
  }
}

async function runBoundAction(
  adapter: string,
  action: Exclude<Action, "connect">,
  bindings: Binding[],
  options: { computer?: string; worktree?: string; json: boolean },
): Promise<void> {
  const worktree = options.worktree ?? await currentWorktree();
  const matching = matchingBindings(bindings, options.computer, worktree);
  requireMatches(matching, "That worktree is not enrolled for the selected Dev Computer.");
  const computers = [...new Set(matching.map(binding => binding.computer))];
  const [computer] = computers;
  if (computers.length !== 1 || computer === undefined) {
    throw cliError("devstack_selection_required", "More than one Computer is enrolled. Pass --computer <handle>.");
  }

  const args = [computer, worktree];
  if (action === "diff") {
    const diff = await adapterRequest(adapter, diffSchema, action, ...args);
    if (options.json) {
      console.log(formatCliSuccess({ computer, worktree, ...diff }));
      return;
    }
    if (!diff.changes.length) console.log("No sync-eligible source changes.");
    for (const entry of diff.changes) console.log(`${entry.status}\t${entry.path}`);
    for (const path of diff.excluded ?? []) console.log(`Excluded\t${path}`);
  } else if (action === "status") {
    const status = await adapterRequest(adapter, statusSchema, action, ...args);
    if (options.json) {
      console.log(formatCliSuccess({ computer, worktree, ...status }));
      return;
    }
    console.log(`Stage 2: ${status.state} (${computer}, ${worktree})`);
    if (status.previewUrl) console.log(`Stage 2 preview: ${status.previewUrl}`);
  } else {
    const synced = await adapterRequest(adapter, syncSchema, action, ...args);
    if (options.json) {
      console.log(formatCliSuccess({ computer, worktree, ...synced }));
      return;
    }
    if (action === "reset") console.log("Reprojected the selected Stage 2 worktree.");
    console.log(`Synced: ${synced.syncScope.join(", ")}`);
  }
}

const commandArgsSchema = z.strictObject({
  _: z.array(z.enum(actions)).max(1),
  action: z.enum(actions).optional(),
  computer: computerSchema.optional(),
  worktree: safeText.optional(),
  stage: z.enum(["2", "3"]).optional(),
  profile: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,30}$/).optional(),
  platform: safeText.max(512).optional(),
  open: z.boolean().optional(),
  json: z.boolean().optional(),
});

type CommandOptions = z.infer<typeof commandArgsSchema>;

function httpsOrigin(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || url.protocol !== "https:" || ![url.origin, url.origin + "/"].includes(value)) {
    throw cliError("devstack_invalid_origin", "Use the approved HTTPS DevStack origin without a path or credentials.");
  }
  return url.origin;
}

async function connectStageThree(options: CommandOptions, interactive: boolean, json: boolean): Promise<void> {
  if (options._[0] && options._[0] !== "connect") {
    throw cliError("devstack_action_unsupported", "Stage 3 opens a registered preview. Source updates belong to the agent's worktree.");
  }
  const { computer, worktree } = options;
  if ((computer !== undefined || worktree !== undefined)
    && (!stageThreeSlug.safeParse(computer).success || !stageThreeSlug.safeParse(worktree).success)) {
    throw cliError("devstack_selection_required", "Use both --computer and --worktree with registered Stage 3 names, or omit both to choose in the browser.");
  }

  let platformUrl = options.platform;
  if (!platformUrl) {
    const { profiles } = await loadProfiles({ migrateLegacyFiles: false });
    const name = options.profile ?? "devstack";
    if (!Object.hasOwn(profiles, name)) {
      throw cliError("devstack_profile_required", "Select a DevStack CLI profile or pass the approved HTTPS origin with --platform.");
    }
    platformUrl = profiles[name]!.platformUrl;
  }
  const path = computer && worktree ? `/devstack/${computer}/${worktree}` : "/devstack";
  const entryUrl = httpsOrigin(platformUrl) + path;
  if (json) {
    console.log(formatCliSuccess({ ...(computer && worktree ? { computer, worktree } : {}), entryUrl }));
  } else {
    console.log(`Stage 3 preview entry: ${entryUrl}`);
  }
  // Stage 3 uses normal Clerk browser login. No Main profile bearer token is
  // sent to the preview origin or placed in the URL.
  if (options.open ?? interactive) openBrowser(entryUrl);
}

export const devstackCommand = defineCommand({
  meta: { name: "devstack", description: "Connect to a DevStack worktree preview" },
  args: {
    action: { type: "positional", required: false, description: "connect (default), sync, diff, status, reset, or watch (Stage 3)" },
    stage: { type: "string", description: "Stage 2 local sync (default) or Stage 3 registered browser preview" },
    profile: { type: "string", description: "Stage 3 CLI profile (default: devstack)" },
    platform: { type: "string", description: "Approved Stage 3 HTTPS origin" },
    computer: { type: "string", description: "Approved Dev Computer name" },
    worktree: { type: "string", description: "Stage 2 local path or Stage 3 registered worktree name" },
    open: { type: "boolean", description: "Open the connected preview in the configured browser" },
    json: { type: "boolean", description: "Print a machine-readable result" },
  },
  async run({ args }) {
    const json = args.json === true;
    try {
      const parsed = commandArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw cliError("devstack_selection_required", "Use matrix devstack [connect|sync|diff|status|reset|watch] --help.");
      }
      const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !json);
      const action = parsed.data._[0] ?? "connect";
      if (action === "watch") {
        if (parsed.data.stage !== "3") {
          throw cliError("devstack_action_unsupported", "Watch requires --stage 3.");
        }
        const computer = stageThreeSlug.safeParse(parsed.data.computer);
        const worktree = stageThreeSlug.safeParse(parsed.data.worktree);
        if (!computer.success || !worktree.success || parsed.data.profile || parsed.data.platform || parsed.data.open !== undefined) {
          throw cliError("devstack_selection_required", "Use watch with the enrolled --computer and --worktree names.");
        }
        await watchStageThree(await localAdapter(3), computer.data, worktree.data, json);
        return;
      }
      if (parsed.data.stage === "3") {
        await connectStageThree(parsed.data, interactive, json);
        return;
      }
      if (parsed.data.profile || parsed.data.platform) {
        throw cliError("devstack_selection_required", "--profile and --platform apply only to Stage 3 previews.");
      }
      if (action !== "connect" && parsed.data.open !== undefined) {
        throw cliError("devstack_selection_required", "--open applies only when connecting a Stage 2 preview.");
      }
      if (action === "connect" && !interactive && (!parsed.data.computer || !parsed.data.worktree)) {
        throw cliError("devstack_selection_required", "Use --computer <handle> and --worktree <path>.");
      }

      const adapter = await localAdapter(2);
      const bindings = await adapterRequest(adapter, bindingsSchema, "list");
      const worktree = parsed.data.worktree === undefined ? undefined : await canonicalPath(parsed.data.worktree);
      const options = { computer: parsed.data.computer, worktree, json };
      if (action === "connect") {
        await connect(adapter, bindings, { ...options, interactive, open: parsed.data.open });
      } else {
        await runBoundAction(adapter, action, bindings, options);
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string" &&
        error.code.startsWith("devstack_") ? error.code : "devstack_failed";
      const message = code !== "devstack_failed" && error instanceof Error
        ? error.message : "Could not complete the DevStack operation.";
      console.error(json ? formatCliError(code, message) : message);
      process.exitCode = 1;
    }
  },
});
