import { afterEach, expect, it, vi } from "vitest";
import * as filesystem from "../../packages/gateway/src/app-gallery/filesystem.js";
import { createAppGalleryService } from "../../packages/gateway/src/app-gallery/service.js";

vi.mock("../../packages/gateway/src/app-gallery/filesystem.js", async original => ({
  ...await original<typeof import("../../packages/gateway/src/app-gallery/filesystem.js")>(),
  pinDirectory: vi.fn(), readLimited: vi.fn(), readTemplate: vi.fn(), createPrivateStage: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const definition = { id: "folio", name: "Folio", collection: "personal", category: "Finance", description: "A ledger", tagline: "Your spending", icon: "wallet", accent: "forest", view: "finance", entity: "Expense", fields: [{ key: "amount", label: "Amount", kind: "money" }], services: [], importGoal: "Extract receipts", highlights: ["Currency totals"] };
const error = (code: string) => Object.assign(new Error("Filesystem error"), { code });
function setup(code = "ENOTDIR") {
  const apps = { child: vi.fn().mockRejectedValue(error(code)), createChild: vi.fn().mockRejectedValue(error("EEXIST")), close: vi.fn() };
  const owner = { child: vi.fn().mockResolvedValue(apps), close: vi.fn() };
  const stage = { write: vi.fn().mockResolvedValue("private-file"), publish: vi.fn(), release: vi.fn() };
  vi.mocked(filesystem.pinDirectory).mockResolvedValue(owner as unknown as Awaited<ReturnType<typeof filesystem.pinDirectory>>);
  vi.mocked(filesystem.readLimited).mockImplementation(async path => Buffer.from(path.endsWith("catalog.json") ? JSON.stringify({ version: 1, apps: [definition, { ...definition, id: "focus", name: "Focus" }] }) : "icon"));
  apps.child.mockImplementation(async id => { throw error(id === "folio" ? code : "ENOENT"); });
  vi.mocked(filesystem.readTemplate).mockResolvedValue(new Map([["dist/index.html", Buffer.from('<script type="application/json" id="matrix-app-definition">__MATRIX_APP_DEFINITION__</script>')], ["index.html", Buffer.from("__MATRIX_APP_DEFINITION__")], ["src/definition.json", Buffer.from("{}")]]));
  vi.mocked(filesystem.createPrivateStage).mockResolvedValue(stage as unknown as Awaited<ReturnType<typeof filesystem.createPrivateStage>>);
  return { apps, owner, stage, service: createAppGalleryService({ homePath: "/owner", catalogPath: "/catalog.json" }) };
}
it("a nondirectory app does not hide the rest of the Gallery", async () => {
  const { owner, apps, service } = setup();
  await expect(service.list()).resolves.toMatchObject([{ id: "folio", installed: false }, { id: "focus", installed: false }]);
  expect(owner.close).toHaveBeenCalledOnce(); expect(apps.close).toHaveBeenCalledOnce();
});
it("installation reports a conflict without publishing over the owner file", async () => {
  const { stage, service } = setup();
  await expect(service.install("folio")).rejects.toMatchObject({ status: 409 });
  expect(stage.publish).not.toHaveBeenCalled(); expect(stage.release).toHaveBeenCalledOnce();
});
it("unexpected filesystem failures remain errors", async () => {
  await expect(setup("EIO").service.list()).rejects.toMatchObject({ code: "EIO" });
});
