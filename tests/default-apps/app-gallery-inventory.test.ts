import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { parseGalleryInventory } from "../../packages/contracts/src/app-gallery-inventory";
import { parseGalleryInventory as galleryParser } from "../../home/apps/app-gallery/src/generated-inventory";
import { parseGalleryInventory as starterParser } from "../../home/app-templates/connected-starter/src/generated-inventory";
import { loadGallery } from "../../home/apps/app-gallery/src/model";
import { ImportDialog } from "../../home/app-templates/connected-starter/src/ImportDialog";
import catalog from "../../home/system/app-gallery.json";
import type { Definition } from "../../home/app-templates/connected-starter/src/types";
const folio = catalog.apps.find((app) => app.id === "folio") as Definition;
const apps = catalog.apps.map((app) => ({ ...app, installed: false }));
function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    service: "gmail",
    account_label: `label-${i}`,
    account_email: `owner-${i}@example.test`,
    status: i === count - 1 ? "active" : "inactive",
  }));
}
afterEach(() => {
  cleanup();
  delete window.MatrixOS;
  vi.restoreAllMocks();
});
describe("canonical connected account inventory", () => {
  for (const count of [100, 101, 2000]) {
    it(`accepts all ${count} accounts in both portable clients without truncating`, async () => {
      const raw = rows(count);
      for (const parse of [parseGalleryInventory, galleryParser, starterParser])
        expect(parse(raw)).toEqual(raw);
      const gallery = await loadGallery({
        gatewayFetch: async () => ({ version: 1, apps }),
        integrations: async () => raw,
      });
      expect(gallery.connections).toEqual(raw);
      window.MatrixOS = { integrations: async () => raw, generate: vi.fn() };
      render(createElement(ImportDialog, { app: folio, onClose: () => {} }));
      await screen.findByText(`label-${count - 1}`);
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });
  }
  it("rejects 2001 accounts and preserves unknown availability in both clients", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = rows(2001);
    for (const parse of [parseGalleryInventory, galleryParser, starterParser])
      expect(() => parse(raw)).toThrow();
    const gallery = await loadGallery({
      gatewayFetch: async () => ({ version: 1, apps }),
      integrations: async () => raw,
    });
    expect(gallery.connections).toBeNull();
    window.MatrixOS = { integrations: async () => raw, generate: vi.fn() };
    render(createElement(ImportDialog, { app: folio, onClose: () => {} }));
    await screen.findByText("Connection availability could not be checked.");
    expect(
      (
        screen.getByRole("button", {
          name: "Ask Matrix to import",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("shares exact safe string limits and preserves labels without normalization", () => {
    const max = {
      service: "a".repeat(64),
      account_label: "x".repeat(160),
      account_email: "e".repeat(320),
      status: "s".repeat(64),
    };
    for (const parse of [parseGalleryInventory, galleryParser, starterParser]) {
      expect(parse([max])).toEqual([max]);
      for (const key of [
        "service",
        "account_label",
        "account_email",
        "status",
      ] as const)
        expect(() => parse([{ ...max, [key]: max[key] + "x" }])).toThrow();
      expect(
        parse([{ ...max, account_label: "  Exact label  " }])[0].account_label,
      ).toBe("  Exact label  ");
      for (const raw of [
        null,
        {},
        [null],
        [[]],
        [{ ...max, account_label: "bad\nlabel" }],
        [{ ...max, status: 9 }],
      ])
        expect(() => parse(raw)).toThrow();
    }
  });
});

it("refreshes both generated parsers and gallery branding in a repository and retains portable owner snapshots", async () => {
  const temp = await mkdtemp(join(tmpdir(), "matrix-inventory-generation-"));
  try {
    const canonical = await readFile(
      "packages/contracts/src/app-gallery-inventory.ts",
      "utf8",
    );
    const brandSnapshot = await readFile(
      "home/apps/app-gallery/src/brand-tokens.css",
      "utf8",
    );
    const pairs = [
      ["home/apps/app-gallery", "sync-contract.mjs"],
      ["home/app-templates/connected-starter", "scripts/sync-inventory.mjs"],
    ];
    for (const [app, script] of pairs) {
      const target = join(temp, app);
      await mkdir(join(target, "src"), { recursive: true });
      await mkdir(join(target, "scripts"), { recursive: true });
      await writeFile(
        join(target, script),
        await readFile(join(app, script), "utf8"),
      );
      await writeFile(
        join(target, "src/generated-inventory.ts"),
        await readFile(join(app, "src/generated-inventory.ts"), "utf8"),
      );
      if (app.endsWith("app-gallery")) {
        await writeFile(
          join(target, "src/generated-contract.ts"),
          await readFile(join(app, "src/generated-contract.ts"), "utf8"),
        );
        await writeFile(
          join(target, "sync-brand-tokens.mjs"),
          await readFile(join(app, "sync-brand-tokens.mjs"), "utf8"),
        );
        await writeFile(join(target, "src/brand-tokens.css"), brandSnapshot);
      }
      execFileSync(process.execPath, [join(target, script)]);
      expect(
        await readFile(join(target, "src/generated-inventory.ts"), "utf8"),
      ).toContain(canonical);
      if (app.endsWith("app-gallery"))
        expect(await readFile(join(target, "src/brand-tokens.css"), "utf8"))
          .toBe(brandSnapshot);
    }
    await mkdir(join(temp, "packages/contracts/src"), { recursive: true });
    await writeFile(
      join(temp, "packages/contracts/src/app-gallery-inventory.ts"),
      canonical + "\n// Refreshed from the canonical repository source.\n",
    );
    await writeFile(
      join(temp, "packages/contracts/src/app-gallery.ts"),
      await readFile("packages/contracts/src/app-gallery.ts", "utf8"),
    );
    await mkdir(join(temp, "packages/brand/src"), { recursive: true });
    await writeFile(
      join(temp, "packages/brand/src/tokens.ts"),
      (await readFile("packages/brand/src/tokens.ts", "utf8"))
        .replace('"#0E3422"', '"#123456"'),
    );
    for (const [app, script] of pairs) {
      execFileSync(process.execPath, [join(temp, app, script)]);
      expect(
        await readFile(join(temp, app, "src/generated-inventory.ts"), "utf8"),
      ).toContain("Refreshed from the canonical repository source.");
      if (app.endsWith("app-gallery"))
        expect(await readFile(join(temp, app, "src/brand-tokens.css"), "utf8"))
          .toContain("--brand-forest: #123456;");
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("normalizes a failed catalog promptly even while optional inventory remains pending", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(loadGallery({
    gatewayFetch: async () => { throw new Error("private database path"); },
    integrations: () => new Promise(() => {}),
  })).rejects.toThrow("Gallery unavailable");
});
