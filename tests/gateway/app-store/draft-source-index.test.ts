import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ status: "ready", reads: 0 }));
vi.mock("../../../packages/gateway/src/app-store/draft-store.js", () => ({
  createDraftStore: () => ({
    read: async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      status: state.status,
      changedFiles: [],
    }),
    files: async (_id: string, kind: string) => {
      state.reads++;
      return new Map(
        kind === "original"
          ? [
              ["src/unchanged.ts", Buffer.from("private sample")],
              ["src/removed.ts", Buffer.from("gone")],
            ]
          : [
              ["src/unchanged.ts", Buffer.from("private sample")],
              ["src/added.ts", Buffer.from("new")],
            ],
      );
    },
  }),
}));
import { createStorePublishService } from "../../../packages/gateway/src/app-store/publish-service.js";
let service: ReturnType<typeof createStorePublishService>;
afterEach(async () => {
  await service?.close();
  state.status = "ready";
  state.reads = 0;
});
function fixture() {
  return (service = createStorePublishService({
    homePath: "/owner",
    platform: {} as any,
    builder: {} as any,
    generalizer: {} as any,
  }));
}
it("includes every source path and change state in owner detail without returning source bytes", async () => {
  const detail = await fixture().detail("11111111-1111-4111-8111-111111111111");
  expect(detail).toMatchObject({
    sourceFiles: [
      { path: "src/added.ts", change: "added" },
      { path: "src/removed.ts", change: "removed" },
      { path: "src/unchanged.ts", change: "unchanged" },
    ],
  });
  expect(JSON.stringify(detail)).not.toContain("private sample");
  expect(state.reads).toBe(2);
});
it("keeps source indexes unavailable while a draft is preparing", async () => {
  state.status = "preparing";
  expect(
    await fixture().detail("11111111-1111-4111-8111-111111111111"),
  ).toMatchObject({ sourceFiles: [] });
  expect(state.reads).toBe(0);
});
