import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { draft } from "../../default-apps/app-store-fixtures";
const state = vi.hoisted(() => ({
  draft: null as any,
  beforeRead: undefined as undefined | (() => Promise<void>),
  beforeFiles: undefined as undefined | (() => void),
}));
vi.mock("../../../packages/gateway/src/app-store/draft-store.js", () => ({
  createDraftStore: () => ({
    read: async () => {
      await state.beforeRead?.();
      return structuredClone(state.draft);
    },
    write: async (value: unknown) => {
      state.draft = structuredClone(value);
    },
    files: async () => {
      state.beforeFiles?.();
      return new Map([
        [
          "matrix.json",
          Buffer.from(
            JSON.stringify({
              name: "Notes",
              description: "Sample notes",
              slug: "sample-notes",
              version: "1.0.0",
              runtime: "vite",
              permissions: [],
            }),
          ),
        ],
      ]);
    },
  }),
}));
import { createStorePublishService } from "../../../packages/gateway/src/app-store/publish-service.js";
let service: ReturnType<typeof createStorePublishService>;
function gateFirstRead() {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  state.beforeRead = async () => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
  };
  return { release, reading };
}
beforeEach(() => {
  state.draft = structuredClone(draft);
  state.beforeRead = undefined;
  state.beforeFiles = undefined;
  service = createStorePublishService({
    homePath: "/owner-read-test",
    platform: {} as any,
    builder: {} as any,
    generalizer: {} as any,
  });
});
afterEach(async () => {
  await service.close();
});
it("allows overlapping detail reads instead of treating them as conflicting mutations", async () => {
  const gate = gateFirstRead();
  const first = service.detail(draft.id);
  await gate.reading;
  const second = service.detail(draft.id).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  gate.release();
  await first;
  expect(await second).toHaveProperty("value.sourceFiles");
});
it("does not make a listing save conflict with a background detail read", async () => {
  const gate = gateFirstRead();
  const read = service.detail(draft.id);
  await gate.reading;
  let result: unknown;
  try {
    result = await service
      .listing(draft.id, { tagline: "Saved during a read" })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
  } finally {
    gate.release();
    await read;
  }
  expect(result).toHaveProperty("value.listing.tagline", "Saved during a read");
});
it("returns a metadata snapshot while a listing mutation is in progress", async () => {
  const gate = gateFirstRead();
  const save = service.listing(draft.id, { tagline: "Saving" });
  await gate.reading;
  let result: unknown;
  try {
    result = await service.detail(draft.id).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  } finally {
    gate.release();
    await save;
  }
  expect(result).toHaveProperty("value.sourceFiles", []);
});
it("does not attach a stale source index when the draft starts preparing during the read", async () => {
  state.beforeFiles = () => {
    state.draft.status = "preparing";
    state.draft.updatedAt = "2026-10-19T12:00:00Z";
  };
  expect(await service.detail(draft.id)).toMatchObject({
    status: "preparing",
    sourceFiles: [],
  });
});
