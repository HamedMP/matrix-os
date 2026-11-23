import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { APP_FILES_BRIDGE_PATH } from "../../../packages/contracts/src/app-files";
import { createAppFileRoutes } from "../../../packages/gateway/src/app-files/routes";
import { invalidateAppIndexCache } from "../../../packages/gateway/src/app-runtime/app-index";

export interface AppFileHarness {
  home: string;
  owner: { id: string | null };
  post(input: unknown, app?: string): Promise<Response>;
  postRaw(body: string): Promise<Response>;
  cleanup(): Promise<void>;
}

export interface InstallAppOptions {
  slug?: string;
  listingTrust?: string;
  permissions?: string[];
  hidden?: boolean;
  scope?: string;
  provenance?: Record<string, unknown>;
}

export async function installApp(home: string, options: InstallAppOptions = {}): Promise<void> {
  const slug = options.slug ?? "docs";
  const appDir = join(home, "apps", slug);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "matrix.json"), JSON.stringify({
    name: slug, slug, version: "1.0.0", runtime: "static", runtimeVersion: "^1.0.0",
    scope: options.scope ?? "personal",
    listingTrust: options.listingTrust ?? "first_party",
    permissions: options.permissions ?? ["files"],
    ...(options.hidden ? { hidden: true } : {}),
    ...options.provenance,
  }));
  invalidateAppIndexCache();
}

export async function createHarness(options: { homePath?: string | null; install?: InstallAppOptions | false } = {}): Promise<AppFileHarness> {
  const home = await mkdtemp(join(tmpdir(), "app-files-"));
  await Promise.all([mkdir(join(home, "system")), mkdir(join(home, "apps"))]);
  if (options.install !== false) await installApp(home, options.install ?? {});
  const owner = { id: "owner" as string | null };
  const host = new Hono();
  host.route(APP_FILES_BRIDGE_PATH, createAppFileRoutes({
    homePath: options.homePath === undefined ? home : options.homePath,
    ownerIds: ["owner"],
    resolveOwner: () => owner.id,
  }));
  const postRaw = (body: string) => host.request(APP_FILES_BRIDGE_PATH, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  return {
    home,
    owner,
    postRaw,
    post: (input, app = "docs") => postRaw(JSON.stringify({ app, input })),
    cleanup: async () => { await rm(home, { recursive: true, force: true }); invalidateAppIndexCache(); },
  };
}

export async function errorCode(response: Response): Promise<string> {
  const body = await response.json() as { error?: { code?: string; message?: string } };
  return body.error?.code ?? "missing";
}
