import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { sql } from "kysely";
import { createDefaultOsViewDesktopIcons } from "@matrix-os/contracts";
import {
  OsViewStateConflictError,
  OsViewStateRepository,
} from "../../packages/gateway/src/os-view-state/repository.js";

describe("OS-view state repository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: OsViewStateRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new OsViewStateRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.destroy();
  });

  it("creates one default document per owner and isolates owners", async () => {
    const alice = await repository.getOrCreate("alice");
    const bob = await repository.getOrCreate("bob");

    expect(alice).toMatchObject({ revision: 1, document: { schemaVersion: 1, apps: [] } });
    expect(bob).toMatchObject({ revision: 1, document: { schemaVersion: 1, apps: [] } });

    const updated = await repository.patch("alice", {
      baseRevision: 1,
      mutationId: `osvm_${"a".repeat(32)}`,
      patch: { pinnedApps: ["__chat__"] },
    });
    expect(updated.document.pinnedApps).toEqual(["__chat__"]);
    expect((await repository.getOrCreate("bob")).document.pinnedApps).toEqual([]);
  });

  it("repairs a pre-marker empty icon layout exactly once", async () => {
    const initial = await repository.getOrCreate("alice");
    const emptied = await repository.patch("alice", {
      baseRevision: initial.revision,
      mutationId: `osvm_${"0".repeat(32)}`,
      patch: { desktop: { icons: [] } },
    });
    await sql`ALTER TABLE os_view_states ALTER COLUMN desktop_icons_initialized_at DROP NOT NULL`.execute(repository.kysely);
    await sql`UPDATE os_view_states
      SET desktop_icons_initialized_at = NULL, legacy_desktop_imported_at = NULL
      WHERE owner_id = 'alice'`.execute(repository.kysely);

    await repository.bootstrap();

    const repaired = await repository.getOrCreate("alice");
    expect(repaired.revision).toBe(emptied.revision + 1);
    expect(repaired.document.desktop.icons).toEqual(createDefaultOsViewDesktopIcons());

    const intentionallyEmpty = await repository.patch("alice", {
      baseRevision: repaired.revision,
      mutationId: `osvm_${"9".repeat(32)}`,
      patch: { desktop: { icons: [] } },
    });
    await repository.bootstrap();
    expect((await repository.getOrCreate("alice"))).toMatchObject({
      revision: intentionallyEmpty.revision,
      document: { desktop: { icons: [] } },
    });
  });

  it("marks customized pre-marker layouts without changing their order or revision", async () => {
    const initial = await repository.getOrCreate("alice");
    const custom = [{ path: "__terminal__", x: 333, y: 444 }];
    const customized = await repository.patch("alice", {
      baseRevision: initial.revision,
      mutationId: `osvm_${"8".repeat(32)}`,
      patch: { desktop: { icons: custom } },
    });
    await sql`ALTER TABLE os_view_states ALTER COLUMN desktop_icons_initialized_at DROP NOT NULL`.execute(repository.kysely);
    await sql`UPDATE os_view_states
      SET desktop_icons_initialized_at = NULL, legacy_desktop_imported_at = NULL
      WHERE owner_id = 'alice'`.execute(repository.kysely);

    await repository.bootstrap();

    expect(await repository.getOrCreate("alice")).toMatchObject({
      revision: customized.revision,
      document: { desktop: { icons: custom } },
    });
  });

  it("imports only present legacy fields once and preserves defaults when icons are absent", async () => {
    const defaults = createDefaultOsViewDesktopIcons();
    const imported = await repository.importLegacyDesktop("alice", {
      pinnedApps: ["__chat__"],
    });
    const repeated = await repository.importLegacyDesktop("alice", {
      pinnedApps: ["__terminal__"],
      desktopIcons: [],
    });

    expect(imported.document.pinnedApps).toEqual(["__chat__"]);
    expect(imported.document.desktop.icons).toEqual(defaults);
    expect(repeated).toEqual(imported);
  });

  it("serializes concurrent legacy imports and applies exactly one payload", async () => {
    await repository.getOrCreate("alice");

    const [first, second] = await Promise.all([
      repository.importLegacyDesktop("alice", { pinnedApps: ["__chat__"] }),
      repository.importLegacyDesktop("alice", { pinnedApps: ["__terminal__"] }),
    ]);

    expect(second).toEqual(first);
    expect([["__chat__"], ["__terminal__"]]).toContainEqual(first.document.pinnedApps);
    expect((await repository.getOrCreate("alice")).revision).toBe(2);
  });

  it("preserves an explicit empty legacy icon layout", async () => {
    const imported = await repository.importLegacyDesktop("alice", {
      pinnedApps: [],
      desktopIcons: [],
    });

    expect(imported.document.desktop.icons).toEqual([]);
    expect((await repository.getOrCreate("alice")).document.desktop.icons).toEqual([]);
  });

  it("lets a current icon write preempt a later legacy import", async () => {
    const initial = await repository.getOrCreate("alice");
    const emptied = await repository.patch("alice", {
      baseRevision: initial.revision,
      mutationId: `osvm_${"6".repeat(32)}`,
      patch: { desktop: { icons: [] } },
    });

    const afterImport = await repository.importLegacyDesktop("alice", {
      desktopIcons: createDefaultOsViewDesktopIcons(),
    });

    expect(afterImport).toEqual(emptied);
    expect(afterImport.document.desktop.icons).toEqual([]);
  });

  it("discards the poisoned empty migration signature from a cached old client", async () => {
    const initial = await repository.getOrCreate("alice");
    const migrated = await repository.patch("alice", {
      baseRevision: initial.revision,
      mutationId: `osvm_${"7".repeat(32)}`,
      patch: { pinnedApps: ["__chat__"], desktop: { icons: [] } },
    });

    expect(migrated.document.pinnedApps).toEqual(["__chat__"]);
    expect(migrated.document.desktop.icons).toEqual(createDefaultOsViewDesktopIcons());
    await expect(repository.importLegacyDesktop("alice", {
      pinnedApps: [],
      desktopIcons: [],
    })).resolves.toEqual(migrated);
  });

  it("enforces the revision in the update and reports the latest revision", async () => {
    await repository.getOrCreate("alice");
    await repository.patch("alice", {
      baseRevision: 1,
      mutationId: `osvm_${"b".repeat(32)}`,
      patch: { desktop: { icons: [{ path: "__chat__", x: 20, y: 20 }] } },
    });

    await expect(repository.patch("alice", {
      baseRevision: 1,
      mutationId: `osvm_${"c".repeat(32)}`,
      patch: { pinnedApps: ["__terminal__"] },
    })).rejects.toEqual(expect.objectContaining<Partial<OsViewStateConflictError>>({
      name: "OsViewStateConflictError",
      latestRevision: 2,
    }));
  });

  it("returns the current document when a committed mutation is retried", async () => {
    await repository.getOrCreate("alice");
    const mutationId = `osvm_${"d".repeat(32)}`;
    const first = await repository.patch("alice", {
      baseRevision: 1,
      mutationId,
      patch: { pinnedApps: ["__chat__"] },
    });
    const retried = await repository.patch("alice", {
      baseRevision: 1,
      mutationId,
      patch: { pinnedApps: ["__chat__"] },
    });

    expect(first.revision).toBe(2);
    expect(retried).toEqual(first);
  });

  it("merges independent namespaces without erasing the other geometry", async () => {
    await repository.getOrCreate("alice");
    const desktop = await repository.patch("alice", {
      baseRevision: 1,
      mutationId: `osvm_${"e".repeat(32)}`,
      patch: { desktop: { windows: [{ path: "__chat__", x: 30, y: 40, width: 900, height: 640 }] } },
    });
    const canvas = await repository.patch("alice", {
      baseRevision: desktop.revision,
      mutationId: `osvm_${"f".repeat(32)}`,
      patch: { canvas: { transform: { panX: -200, panY: 80, zoom: 0.8 } } },
    });

    expect(canvas.document.desktop.windows[0]?.x).toBe(30);
    expect(canvas.document.canvas.transform).toEqual({ panX: -200, panY: 80, zoom: 0.8 });
  });

  it("serializes independent patches and preserves both after the conflicted writer rebases", async () => {
    await repository.getOrCreate("alice");
    const desktop = await repository.patch("alice", {
      baseRevision: 1,
      mutationId: `osvm_${"1".repeat(32)}`,
      patch: { desktop: { icons: [{ path: "__chat__", x: 24, y: 32 }] } },
    });

    const canvasRequest = {
      baseRevision: 1,
      mutationId: `osvm_${"2".repeat(32)}`,
      patch: { canvas: { transform: { panX: -120, panY: 48, zoom: 0.75 } } },
    } as const;
    await expect(repository.patch("alice", canvasRequest)).rejects.toBeInstanceOf(
      OsViewStateConflictError,
    );

    const latest = await repository.getOrCreate("alice");
    const rebased = await repository.patch("alice", {
      ...canvasRequest,
      baseRevision: latest.revision,
    });

    expect(desktop.revision).toBe(2);
    expect(rebased.revision).toBe(3);
    expect(rebased.document.desktop.icons).toEqual([{ path: "__chat__", x: 24, y: 32 }]);
    expect(rebased.document.canvas.transform).toEqual({ panX: -120, panY: 48, zoom: 0.75 });
  });
});
