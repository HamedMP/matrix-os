import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import {
  ProviderSettingsController,
  createProviderSettingsSnapshotCache,
} from "../../packages/ui/src/agents-providers/provider-settings-controller";
import { snapshot, start } from "./provider-managed-credit-fixture";

// ENG-522: Settings → Agents & providers stayed blank for 3-18 s on every open
// because each mount built a new controller with no snapshot and two mounted
// controllers each started their own full snapshot read.

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("opens with the last verified snapshot for the same identity while it refreshes", async () => {
  const cache = createProviderSettingsSnapshotCache();
  const first = snapshot();
  const transport = { getSnapshot: vi.fn(async () => structuredClone(first)), mutate: vi.fn() };
  const earlier = new ProviderSettingsController({ identityKey: "owner/main", transport, snapshotCache: cache });
  await earlier.refresh({ refresh: false });
  earlier.dispose();

  const slow = deferred<ProviderSettingsSnapshot>();
  const newer = { ...structuredClone(first), revision: first.revision + 1 };
  transport.getSnapshot.mockImplementationOnce(() => slow.promise);
  const reopened = new ProviderSettingsController({ identityKey: "owner/main", transport, snapshotCache: cache });
  // Shown at once, before any read, labelled by its own refreshedAt.
  expect(reopened.getState().snapshot?.revision).toBe(first.revision);
  expect(reopened.getState().snapshotFromCache).toBe(true);
  const refreshing = reopened.refresh({ refresh: false });
  expect(reopened.getState().busy).toBe(true);
  slow.resolve(newer);
  await refreshing;
  expect(reopened.getState().snapshot?.revision).toBe(first.revision + 1);
  expect(reopened.getState().snapshotFromCache).toBe(false);
  reopened.dispose();
});

it("never shows one identity's snapshot to another", async () => {
  const cache = createProviderSettingsSnapshotCache();
  const transport = { getSnapshot: vi.fn(async () => snapshot()), mutate: vi.fn() };
  const owner = new ProviderSettingsController({ identityKey: "owner/main", transport, snapshotCache: cache });
  await owner.refresh({ refresh: false });
  owner.dispose();
  const other = new ProviderSettingsController({ identityKey: "other/main", transport, snapshotCache: cache });
  expect(other.getState().snapshot).toBeNull();
  other.dispose();
});

it("shares one snapshot read between controllers opened together, and a forced refresh still reads", async () => {
  const cache = createProviderSettingsSnapshotCache();
  const slow = deferred<ProviderSettingsSnapshot>();
  const transport = { getSnapshot: vi.fn(() => slow.promise), mutate: vi.fn() };
  const left = new ProviderSettingsController({ identityKey: "owner/main", transport, snapshotCache: cache });
  const right = new ProviderSettingsController({ identityKey: "owner/main", transport, snapshotCache: cache });
  const reads = [left.refresh({ refresh: false }), right.refresh({ refresh: false })];
  expect(transport.getSnapshot).toHaveBeenCalledTimes(1);
  slow.resolve(snapshot());
  await Promise.all(reads);
  expect(left.getState().snapshot).not.toBeNull();
  expect(right.getState().snapshot).not.toBeNull();
  transport.getSnapshot.mockImplementation(async () => snapshot());
  await left.refresh();
  expect(transport.getSnapshot).toHaveBeenCalledTimes(2);
  expect(transport.getSnapshot).toHaveBeenLastCalledWith(expect.anything(), { refresh: true });
  left.dispose();
  right.dispose();
});

it("keeps a shared read alive when only one of its controllers closes", async () => {
  const cache = createProviderSettingsSnapshotCache();
  const slow = deferred<ProviderSettingsSnapshot>();
  let signal: AbortSignal | undefined;
  const transport = { getSnapshot: vi.fn((received: AbortSignal) => { signal = received; return slow.promise; }), mutate: vi.fn() };
  const closing = new ProviderSettingsController({ identityKey: "owner/main", transport, snapshotCache: cache });
  const staying = new ProviderSettingsController({ identityKey: "owner/main", transport, snapshotCache: cache });
  void closing.refresh({ refresh: false });
  const read = staying.refresh({ refresh: false });
  closing.dispose();
  expect(signal?.aborted).toBe(false);
  slow.resolve(snapshot());
  await read;
  expect(staying.getState().snapshot).not.toBeNull();
  staying.dispose();
});

it("holds at most four identities", async () => {
  const cache = createProviderSettingsSnapshotCache();
  const transport = { getSnapshot: vi.fn(async () => snapshot()), mutate: vi.fn() };
  for (let index = 0; index < 5; index++) {
    const controller = new ProviderSettingsController({ identityKey: `owner/${index}`, transport, snapshotCache: cache });
    await controller.refresh({ refresh: false });
    controller.dispose();
  }
  expect(cache.get("owner/0")).toBeUndefined();
  expect(cache.get("owner/4")).toBeDefined();
});
