import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import type { CanonicalOwnerScope } from "@matrix-os/contracts";
import { AppManifestSchema, SAFE_SLUG } from "../app-runtime/manifest-schema.js";
import { resolveWithinHome } from "../path-security.js";
import { BoundedActionJsonSchema } from "@matrix-os/contracts";
import { normalizedArgumentDigest, sha256Hex } from "./argument-digest.js";
import { CanonicalActionError } from "./action-repository.js";
export interface QualifiedActionTool { toolId: string; schemaRevision: string; description: string; inputSchema: Record<string, unknown>; effect: "read" | "navigation" | "files" | "data"; approval: boolean; reconciliation: boolean; cancellation: "before_dispatch" }
export interface ActionToolInput { owner: CanonicalOwnerScope; actionId: string; arguments: unknown; signal: AbortSignal }
export interface CanonicalActionTool extends QualifiedActionTool {
  normalize(input: unknown): unknown;
  execute(input: ActionToolInput): Promise<unknown>;
  reconcile?(input: ActionToolInput): Promise<{ confirmed: boolean; result?: unknown }>;
}
const appSchema = z.object({ app: z.string().regex(SAFE_SLUG) }).strict();
const safePath = z.string().min(1).max(160).refine((p) => {
  const segments = p.split("/");
  if (!segments.every((s) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(s) && !/(env|secret|credential|auth|config|token|password)/i.test(s))) return false;
  return ["matrix.json", "package.json", "index.html"].includes(p) || /^(src|public)\/.+\.(tsx?|jsx?|css|html|json|md|txt|svg)$/.test(p);
});
const batchSchema = z.object({ app: z.string().regex(SAFE_SLUG), files: z.array(z.object({ path: safePath, content: z.string().max(32_768).refine((content) => Buffer.byteLength(content, "utf8") <= 32_768, "File content too large"), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).min(1).max(24) }).strict().superRefine((v, ctx) => {
  if (new Set(v.files.map((f) => f.path)).size !== v.files.length) ctx.addIssue({ code: "custom", message: "Duplicate file" });
});
const inspectSchema = appSchema.extend({ paths: z.array(safePath).max(8).refine((paths) => new Set(paths).size === paths.length, "Duplicate path").optional() }).strict();
async function boundedEntries(path: string) {
  const directory = await opendir(path);
  const entries = [];
  for await (const entry of directory) {
    if (entries.length >= 256) throw new CanonicalActionError();
    entries.push(entry);
  }
  return entries;
}
async function optionalStat(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function safeFile(home: string, path: string): Promise<string> {
  const resolved = resolveWithinHome(home, path);
  if (!resolved) throw new CanonicalActionError();
  let parent = home;
  const base = await lstat(home);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new CanonicalActionError();
  for (const segment of path.split("/")) {
    parent = join(parent, segment);
    const stat = await optionalStat(parent);
    if (stat?.isSymbolicLink()) throw new CanonicalActionError();
  }
  return resolved;
}
async function boundedText(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32_768) throw new CanonicalActionError();
    const bytes = Buffer.alloc(32_769);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 32_768) throw new CanonicalActionError();
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
export function createCanonicalActionTools(options: { homeForOwner(owner: CanonicalOwnerScope): Promise<string> }): readonly CanonicalActionTool[] {
  const searchSchema = z.object({ query: z.string().trim().min(1).max(160), app: z.string().regex(SAFE_SLUG) }).strict();
  const schemas: Record<string, z.ZodType> = { matrix_list_apps: z.object({}).strict(), matrix_inspect_app: inspectSchema, matrix_search_workspace: searchSchema, matrix_open_app: appSchema, matrix_close_app: appSchema, matrix_apply_app_files: batchSchema };
  const descriptions: Record<string, string> = { matrix_list_apps: "List bounded owner Vite apps.", matrix_inspect_app: "Inspect an exact owner app without secret/config reads.", matrix_search_workspace: "Search bounded safe source text in one owner app.", matrix_open_app: "Return navigation intent for an exact validated existing owner app.", matrix_close_app: "Close only the window for an exact validated installed owner app. Does not delete the app or its data.", matrix_apply_app_files: "Propose an approved bounded owner Vite app file batch. Every existing file needs its expected SHA256; null means exclusive create. Never installs dependencies or runs code." };
  const meta = (toolId: string, effect: QualifiedActionTool["effect"], approval = false): QualifiedActionTool => ({ toolId, schemaRevision: "canonical_apps_v1", description: descriptions[toolId]!, inputSchema: z.toJSONSchema(schemas[toolId]!), effect, approval, reconciliation: effect === "files", cancellation: "before_dispatch" });
  const normalize = (schema: z.ZodType) => (input: unknown) => { BoundedActionJsonSchema.parse(input); const args = schema.parse(input); BoundedActionJsonSchema.parse(args); return args; };
  const manifest = async (home: string, app: string, discovery = false) => {
    const path = await safeFile(home, `apps/${app}/matrix.json`);
    let text: string;
    try { text = await boundedText(path); }
    catch (error: unknown) {
      if (discovery && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed;
    try { parsed = AppManifestSchema.parse(JSON.parse(text)); }
    catch (error: unknown) {
      if (discovery && (error instanceof SyntaxError || error instanceof z.ZodError)) return null;
      throw error;
    }
    if (parsed.slug !== app || parsed.runtime !== "vite") {
      if (discovery) return null;
      throw new CanonicalActionError();
    }
    return parsed;
  };
  const list: CanonicalActionTool = { ...meta("matrix_list_apps", "read"), normalize: normalize(z.object({}).strict()), async execute(input) {
    input.signal.throwIfAborted(); const home = await options.homeForOwner(input.owner);
    const apps = await safeFile(home, "apps");
    const entries = await boundedEntries(apps);
    if (entries.length > 256) throw new CanonicalActionError();
    const results = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      input.signal.throwIfAborted();
      if (!entry.isDirectory() || !SAFE_SLUG.test(entry.name)) continue;
      const m = await manifest(home, entry.name, true);
      if (!m) continue;
      results.push({ app: m.slug, name: m.name.slice(0, 160) });
    }
    return BoundedActionJsonSchema.parse({ apps: results });
  } };
  const inspect: CanonicalActionTool = { ...meta("matrix_inspect_app", "read"), normalize: normalize(inspectSchema), async execute(input) {
    input.signal.throwIfAborted(); const args = inspectSchema.parse(input.arguments); const home = await options.homeForOwner(input.owner); const m = await manifest(home, args.app);
    if (!m) throw new CanonicalActionError();
    const files = [];
    for (const path of args.paths ?? []) {
      input.signal.throwIfAborted();
      const content = await boundedText(await safeFile(home, `apps/${args.app}/${path}`));
      files.push({ path, sha256: sha256Hex(content), text: content.slice(0, 1_024), truncated: content.length > 1_024 });
    }
    return { app: m.slug, name: m.name.slice(0, 160), runtime: m.runtime, path: `apps/${m.slug}`, files };
  } };
  const search: CanonicalActionTool = { ...meta("matrix_search_workspace", "read"), normalize: normalize(searchSchema), async execute(input) {
    const args = searchSchema.parse(input.arguments); const home = await options.homeForOwner(input.owner); await manifest(home, args.app);
    let visited = 0; let totalBytes = 0; const matches: Array<{ path: string; line: number; text: string }> = [];
    async function walk(relative: string, depth: number): Promise<void> {
      input.signal.throwIfAborted(); if (depth > 8) return;
      const path = await safeFile(home, `apps/${args.app}/${relative}`);
      const entries = await boundedEntries(path); if (entries.length > 256) throw new CanonicalActionError();
      for (const entry of entries) {
        if (++visited > 256 || matches.length >= 32 || totalBytes > 512_000) return;
        const candidate = `${relative}/${entry.name}`;
        if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name) && !/(auth|secret|config|token)/i.test(entry.name)) await walk(candidate, depth + 1);
        else if (entry.isFile() && safePath.safeParse(candidate).success) {
          const text = await boundedText(await safeFile(home, `apps/${args.app}/${candidate}`)); totalBytes += Buffer.byteLength(text);
          text.split("\n").forEach((line, n) => { if (matches.length < 32 && line.toLowerCase().includes(args.query.toLowerCase())) matches.push({ path: `apps/${args.app}/${candidate}`, line: n + 1, text: line.slice(0, 240) }); });
        }
      }
    }
    await walk("src", 0); return { matches };
  } };
  const openApp: CanonicalActionTool = { ...meta("matrix_open_app", "navigation"), normalize: normalize(appSchema), async execute(input) {
    const info = await inspect.execute(input) as { app: string; path: string }; return { ...info, navigation: { kind: "open_app", app: info.app, path: info.path } };
  } };
  const closeApp: CanonicalActionTool = { ...meta("matrix_close_app", "navigation"), normalize: normalize(appSchema), async execute(input) {
    const info = await inspect.execute(input) as { app: string; path: string };
    return { app: info.app, navigation: { kind: "close_app", app: info.app, path: info.path } };
  } };
  const apply: CanonicalActionTool = { ...meta("matrix_apply_app_files", "files", true), normalize: normalize(batchSchema), async execute(input) {
    input.signal.throwIfAborted(); const args = batchSchema.parse(input.arguments); const home = await options.homeForOwner(input.owner);
    const root = await safeFile(home, `apps/${args.app}`);
    // One exclusive owner-app lock fences concurrent canonical actors. Never reclaim a stale lock automatically.
    // A crashed writer leaves an explicit recovery gate; hashes below can confirm effects without replay.
    const lockPath = await safeFile(home, `apps/${args.app}.action-lock`);
    const lock = await open(lockPath, "wx", 0o600);
    const temps: string[] = [];
    try {
      await lock.writeFile(JSON.stringify({ actionId: input.actionId, digest: normalizedArgumentDigest(args) }));
      const virtual = async (p: string) => args.files.find((f) => f.path === p)?.content ?? await boundedText(await safeFile(home, `apps/${args.app}/${p}`));
      const m = AppManifestSchema.parse(JSON.parse(await virtual("matrix.json")));
      const pkg = JSON.parse(await virtual("package.json"));
      if (m.slug !== args.app || m.runtime !== "vite" || m.scope !== "personal" || m.permissions.length || m.database || m.serve || m.build?.output !== "dist" || !["pnpm exec vite build", "vite build", "pnpm build"].includes(m.build?.command ?? "")) throw new CanonicalActionError();
      if (!["pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile --ignore-scripts", "pnpm install --ignore-scripts"].includes(m.build?.install ?? "")) throw new CanonicalActionError();
      if (!pkg.dependencies?.react || !pkg.dependencies?.["react-dom"] || !(pkg.devDependencies?.vite || pkg.dependencies?.vite)) throw new CanonicalActionError();
      const allowedScripts: Record<string, readonly string[]> = { dev: ["vite", "vite --host 0.0.0.0"], build: ["vite build"], preview: ["vite preview", "vite preview --host 0.0.0.0"] };
      if (pkg.scripts && Object.entries(pkg.scripts).some(([key, value]) => !allowedScripts[key]?.includes(value as string))) throw new CanonicalActionError();
      if (m.build?.command === "pnpm build" && pkg.scripts?.build !== "vite build") throw new CanonicalActionError();
      await virtual("index.html"); await virtual("src/main.tsx");
      // Verify every precondition before the first bundle write.
      for (const file of args.files) {
        const target = await safeFile(home, `apps/${args.app}/${file.path}`); const stat = await optionalStat(target);
        if (file.expectedSha256 === null ? stat !== null : !stat || sha256Hex(await boundedText(target)) !== file.expectedSha256) throw new CanonicalActionError();
      }
      input.signal.throwIfAborted(); await mkdir(root, { recursive: true });
      for (let index = 0; index < args.files.length; index++) {
        const file = args.files[index]!;
        input.signal.throwIfAborted(); const target = await safeFile(home, `apps/${args.app}/${file.path}`);
        await mkdir(dirname(target), { recursive: true });
        const temp = `${target}.${input.actionId}.${index}.tmp`; temps.push(temp);
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(file.content); await handle.sync(); } finally { await handle.close(); }
        // Recheck immediately before commit. Null is an atomic exclusive create via link.
        if (file.expectedSha256 === null) await link(temp, target);
        else {
          if (sha256Hex(await boundedText(target)) !== file.expectedSha256) throw new CanonicalActionError();
          await rename(temp, target);
        }
      }
      return { app: args.app, artifact: { kind: "app", path: `apps/${args.app}` }, navigation: { kind: "open_app", app: args.app, path: `apps/${args.app}` }, files: args.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) })) };
    } finally {
      await lock.close();
      for (const temp of temps) { try { await unlink(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[chat/actions] temp cleanup failed", (error as Error).name); } }
      await unlink(lockPath);
    }
  }, async reconcile(input) {
    const args = batchSchema.parse(input.arguments); const home = await options.homeForOwner(input.owner);
    for (const file of args.files) {
      const path = await safeFile(home, `apps/${args.app}/${file.path}`);
      if (!await optionalStat(path) || sha256Hex(await boundedText(path)) !== sha256Hex(file.content)) return { confirmed: false };
    }
    return { confirmed: true, result: { app: args.app, artifact: { kind: "app", path: `apps/${args.app}` }, navigation: { kind: "open_app", app: args.app, path: `apps/${args.app}` } } };
  } };
  return Object.freeze([list, inspect, search, openApp, closeApp, apply]);
}
