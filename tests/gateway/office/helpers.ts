import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { OFFICE_DOCUMENTS_BASE_PATH } from "../../../packages/contracts/src/office-documents";
import { createOfficeDocumentRoutes, type OfficeDocumentRouteOptions } from "../../../packages/gateway/src/office/routes";
import { openDocx } from "../../../packages/office/src/docx/index.js";
import { openXlsx } from "../../../packages/office/src/xlsx/index.js";

export const FIXTURES = fileURLToPath(new URL("../../office/fixtures/", import.meta.url));
export const FIXED_NOW = new Date("2026-11-23T10:00:00.000Z");

export interface OfficeHarness {
  home: string;
  post(route: string, body: unknown): Promise<Response>;
  postRaw(route: string, body: string, headers?: Record<string, string>): Promise<Response>;
  copyFixture(name: string, to?: string): Promise<string>;
  bytes(path: string): Promise<Uint8Array>;
  docx(path: string): ReturnType<typeof openDocx>;
  xlsx(path: string): ReturnType<typeof openXlsx>;
  cleanup(): Promise<void>;
}

export async function createOfficeHarness(
  options: Partial<OfficeDocumentRouteOptions> & { homePath?: string | null } = {},
): Promise<OfficeHarness> {
  const home = await mkdtemp(join(tmpdir(), "office-docs-"));
  await Promise.all([mkdir(join(home, "system")), mkdir(join(home, "docs"))]);
  const host = new Hono();
  host.route(OFFICE_DOCUMENTS_BASE_PATH, createOfficeDocumentRoutes({
    clock: () => FIXED_NOW,
    ...options,
    homePath: options.homePath === undefined ? home : options.homePath,
  }));
  const postRaw = (route: string, body: string, headers: Record<string, string> = {}) =>
    host.request(`${OFFICE_DOCUMENTS_BASE_PATH}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const bytes = async (path: string) => new Uint8Array(await readFile(join(home, path)));
  return {
    home,
    postRaw,
    post: (route, body) => postRaw(route, JSON.stringify(body)),
    copyFixture: async (name, to = `docs/${name}`) => {
      await mkdir(dirname(join(home, to)), { recursive: true });
      await copyFile(join(FIXTURES, name), join(home, to));
      return to;
    },
    bytes,
    docx: async (path) => openDocx(await bytes(path)),
    xlsx: async (path) => openXlsx(await bytes(path)),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
