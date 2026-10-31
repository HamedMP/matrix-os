import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { GettingStartedAppRepository } from "../../packages/gateway/src/getting-started-app/repository.js";

describe("Getting started app repository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: GettingStartedAppRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new GettingStartedAppRepository(pglite.dialect);
    await repository.bootstrap();
  });

  afterEach(async () => {
    await repository.destroy();
  });

  it("starts every owner at zero", async () => {
    await expect(repository.progress("alice")).resolves.toEqual({ awards: [], total: 0 });
  });

  it("awards a task's server-side points once", async () => {
    const first = await repository.award("alice", "slack", false);
    expect(first).toEqual({ awarded: true, points: 20, total: 20 });

    const again = await repository.award("alice", "slack", false);
    expect(again).toEqual({ awarded: false, points: 20, total: 20 });

    const progress = await repository.progress("alice");
    expect(progress.total).toBe(20);
    expect(progress.awards).toHaveLength(1);
    expect(progress.awards[0]).toMatchObject({ taskId: "slack", points: 20 });
    expect(Number.isNaN(Date.parse(progress.awards[0]!.awardedAt))).toBe(false);
  });

  it("adds totals across tasks and keeps owners apart", async () => {
    await repository.award("alice", "first-prompt", true);
    await repository.award("alice", "github", false);
    await repository.award("bob", "slack", false);

    expect((await repository.progress("alice")).total).toBe(70);
    expect((await repository.progress("bob")).total).toBe(20);
  });

  it("records one award when two requests race", async () => {
    const results = await Promise.all([
      repository.award("alice", "slack", false),
      repository.award("alice", "slack", false),
      repository.award("alice", "slack", true),
    ]);
    expect(results.filter((result) => result.awarded)).toHaveLength(1);
    expect((await repository.progress("alice")).total).toBe(20);
  });

  it("allows the automatic first open once per owner", async () => {
    await expect(repository.claimAutoOpen("alice")).resolves.toBe(true);
    await expect(repository.claimAutoOpen("alice")).resolves.toBe(false);
    await expect(repository.claimAutoOpen("bob")).resolves.toBe(true);
  });

  it("allows the automatic first open once when surfaces race", async () => {
    const claims = await Promise.all([
      repository.claimAutoOpen("alice"),
      repository.claimAutoOpen("alice"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("records the desktop icon only once a surface confirms it was saved", async () => {
    await expect(repository.desktopIconPlaced("alice")).resolves.toBe(false);
    // A surface that failed to save never marks it, so the next load tries again.
    await expect(repository.desktopIconPlaced("alice")).resolves.toBe(false);
    await repository.markDesktopIconPlaced("alice");
    await expect(repository.desktopIconPlaced("alice")).resolves.toBe(true);
    await expect(repository.desktopIconPlaced("bob")).resolves.toBe(false);
  });

  it("keeps the first placement time and the first open separate", async () => {
    await repository.markDesktopIconPlaced("alice");
    await repository.markDesktopIconPlaced("alice");
    await expect(repository.desktopIconPlaced("alice")).resolves.toBe(true);
    await expect(repository.claimAutoOpen("alice")).resolves.toBe(true);
    await expect(repository.claimAutoOpen("alice")).resolves.toBe(false);
  });

  it("can bootstrap twice without losing awards", async () => {
    await repository.award("alice", "slack", false);
    await repository.bootstrap();
    expect((await repository.progress("alice")).total).toBe(20);
  });
});
