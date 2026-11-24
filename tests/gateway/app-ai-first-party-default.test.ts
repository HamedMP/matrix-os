import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isAppAiAllowed } from "../../packages/gateway/src/app-ai/runtime.js";
import { createAppCapabilityRoutes } from "../../packages/gateway/src/app-capabilities/routes.js";

// The office apps' assistants call MatrixOS.ai.generate. A fresh install has no
// system/app-ai.json, so without a shipped first-party default every assistant
// answers "unavailable". These tests pin who gets that default: only the real
// first-party office apps, never an imported or third-party app with the same name.

const REPO_APPS = join(import.meta.dirname, "../../home/apps");
let homePath: string;

beforeEach(async () => {
  homePath = await mkdtemp(join(tmpdir(), "app-ai-default-"));
  await mkdir(join(homePath, "system"), { recursive: true });
});
afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

async function shippedManifest(slug: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(REPO_APPS, slug, "matrix.json"), "utf8")) as Record<string, unknown>;
}

async function installApp(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(join(homePath, "apps", dir), { recursive: true });
  await writeFile(join(homePath, "apps", dir, "matrix.json"), JSON.stringify(manifest));
}

async function capabilitiesAi(app: string): Promise<unknown> {
  const routes = createAppCapabilityRoutes({
    homePath, ownerIds: ["owner"], resolveOwner: () => "owner", integrations: null,
    aiAllowed: identity => isAppAiAllowed(homePath, identity),
  });
  const response = await routes.request("/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app, input: { kind: "capabilities" } }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { ai?: unknown }).ai;
}

it("grants app AI to the shipped first-party office apps in a fresh install", async () => {
  for (const slug of ["docs", "sheets"]) await installApp(slug, await shippedManifest(slug));
  for (const slug of ["docs", "sheets"]) {
    expect(await isAppAiAllowed(homePath, slug)).toBe(true);
    expect(await capabilitiesAi(slug)).toBe(true);
  }
});

it("does not grant app AI to an imported app that reuses an office app name", async () => {
  await installApp("docs", { ...await shippedManifest("docs"), installed_from: { source: "gallery", listingId: "x" } });
  await installApp("sheets", { ...await shippedManifest("sheets"), forked_from: { listingId: "y" } });
  expect(await isAppAiAllowed(homePath, "docs")).toBe(false);
  expect(await isAppAiAllowed(homePath, "sheets")).toBe(false);
  expect(await capabilitiesAi("docs")).toBe(false);
});

it("does not grant app AI to a third-party, shared or hidden app with an office name", async () => {
  const docs = await shippedManifest("docs");
  await installApp("docs", { ...docs, listingTrust: "community" });
  await installApp("sheets", { ...await shippedManifest("sheets"), hidden: true });
  expect(await isAppAiAllowed(homePath, "docs")).toBe(false);
  expect(await isAppAiAllowed(homePath, "sheets")).toBe(false);
});

it("keeps every other first-party and unknown app fail-closed without an owner grant", async () => {
  await installApp("notes", await shippedManifest("notes"));
  expect(await isAppAiAllowed(homePath, "notes")).toBe(false);
  expect(await isAppAiAllowed(homePath, "docs")).toBe(false);
});

it("treats an owner-written policy as authoritative, so the owner can revoke the default", async () => {
  for (const slug of ["docs", "sheets"]) await installApp(slug, await shippedManifest(slug));
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: ["sheets"] }));
  expect(await isAppAiAllowed(homePath, "docs")).toBe(false);
  expect(await isAppAiAllowed(homePath, "sheets")).toBe(true);
  await writeFile(join(homePath, "system/app-ai.json"), JSON.stringify({ apps: [] }));
  expect(await isAppAiAllowed(homePath, "sheets")).toBe(false);
});

it("never turns a malformed owner policy into the default grant", async () => {
  await installApp("docs", await shippedManifest("docs"));
  await writeFile(join(homePath, "system/app-ai.json"), "not json");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await expect(isAppAiAllowed(homePath, "docs")).rejects.toThrow();
  warn.mockRestore();
});
