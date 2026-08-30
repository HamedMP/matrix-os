import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDesktopIconsHydrationRevision,
  resetDesktopIconsRuntime,
  useDesktopIcons,
} from "@desktop/renderer/src/stores/desktop-icons";

const CHAT = { path: "__chat__", x: 20, y: 20 };
const FILES = { path: "__file-browser__", x: 108, y: 20 };

describe("native Desktop icon layout", () => {
  beforeEach(() => {
    resetDesktopIconsRuntime();
    useDesktopIcons.setState(useDesktopIcons.getInitialState(), true);
  });

  it("loads the owner-controlled layout from desktop settings", async () => {
    const api = { get: vi.fn(async () => ({ desktopIcons: [FILES] })) };

    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    expect(useDesktopIcons.getState().icons).toEqual([FILES]);
  });

  it("persists moving, removing, and adding icons through the bounded desktop patch", async () => {
    const api = {
      get: vi.fn(async () => ({ desktopIcons: [CHAT, FILES] })),
      patch: vi.fn(async () => ({ ok: true })),
    };
    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    await useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    await useDesktopIcons.getState().remove("__file-browser__", api as never);
    await useDesktopIcons.getState().add("apps/notes/index.html", api as never);

    expect(useDesktopIcons.getState().icons).toContainEqual({ path: "__chat__", x: 240, y: 180 });
    expect(useDesktopIcons.getState().icons.some((icon) => icon.path === "__file-browser__")).toBe(false);
    expect(useDesktopIcons.getState().icons.some((icon) => icon.path === "apps/notes/index.html")).toBe(true);
    expect(api.patch).toHaveBeenLastCalledWith("/api/settings/desktop", {
      desktopIcons: useDesktopIcons.getState().icons,
    });
  });

  it("rolls the optimistic layout back when persistence fails", async () => {
    const api = {
      get: vi.fn(async () => ({ desktopIcons: [CHAT, FILES] })),
      patch: vi.fn(async () => { throw new Error("offline"); }),
    };
    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    await useDesktopIcons.getState().move("__chat__", 240, 180, api as never);

    expect(useDesktopIcons.getState().icons).toEqual([CHAT, FILES]);
  });

  it("allows pending settings hydration after an initial icon write fails", async () => {
    const api = {
      patch: vi.fn(async () => { throw new Error("offline"); }),
    };
    const pendingHydrationRevision = captureDesktopIconsHydrationRevision();
    useDesktopIcons.getState().prime([CHAT, FILES]);

    await useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    useDesktopIcons.getState().hydrate([FILES], [CHAT, FILES], pendingHydrationRevision);

    expect(api.patch).toHaveBeenCalledWith("/api/settings/desktop", {
      desktopIcons: [
        { path: "__chat__", x: 240, y: 180 },
        FILES,
      ],
    });
    expect(useDesktopIcons.getState()).toMatchObject({ icons: [FILES], loaded: true });
  });

  it("replays settings hydration that resolves before an initial icon write fails", async () => {
    let rejectPatch: ((error: Error) => void) | undefined;
    const api = {
      patch: vi.fn(() => new Promise<never>((_resolve, reject) => {
        rejectPatch = reject;
      })),
    };
    const pendingHydrationRevision = captureDesktopIconsHydrationRevision();
    useDesktopIcons.getState().prime([CHAT, FILES]);

    const move = useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    useDesktopIcons.getState().hydrate([FILES], [CHAT, FILES], pendingHydrationRevision);
    rejectPatch?.(new Error("offline"));
    await move;

    expect(useDesktopIcons.getState()).toMatchObject({ icons: [FILES], loaded: true });
  });

  it("replays hydration captured between two failed initial icon writes", async () => {
    const rejectPatch: Array<(error: Error) => void> = [];
    const api = {
      patch: vi.fn(() => new Promise<never>((_resolve, reject) => {
        rejectPatch.push(reject);
      })),
    };
    useDesktopIcons.getState().prime([CHAT, FILES]);

    const move = useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const intermediateHydrationRevision = captureDesktopIconsHydrationRevision();
    const remove = useDesktopIcons.getState().remove("__file-browser__", api as never);
    useDesktopIcons.getState().hydrate([FILES], [CHAT, FILES], intermediateHydrationRevision);
    rejectPatch[0]?.(new Error("first offline"));
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    rejectPatch[1]?.(new Error("second offline"));
    await Promise.all([move, remove]);

    expect(useDesktopIcons.getState()).toMatchObject({ icons: [FILES], loaded: true });
  });

  it("accepts intermediate hydration after both initial icon writes already failed", async () => {
    const rejectPatch: Array<(error: Error) => void> = [];
    const api = {
      patch: vi.fn(() => new Promise<never>((_resolve, reject) => {
        rejectPatch.push(reject);
      })),
    };
    useDesktopIcons.getState().prime([CHAT, FILES]);

    const move = useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const intermediateHydrationRevision = captureDesktopIconsHydrationRevision();
    const remove = useDesktopIcons.getState().remove("__file-browser__", api as never);
    rejectPatch[0]?.(new Error("first offline"));
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    rejectPatch[1]?.(new Error("second offline"));
    await Promise.all([move, remove]);
    useDesktopIcons.getState().hydrate([FILES], [CHAT, FILES], intermediateHydrationRevision);

    expect(useDesktopIcons.getState()).toMatchObject({ icons: [FILES], loaded: true });
  });

  it("keeps a later successful queued layout when an earlier write fails", async () => {
    const api = {
      get: vi.fn(async () => ({ desktopIcons: [CHAT, FILES] })),
      patch: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ ok: true }),
    };
    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    const move = useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    const remove = useDesktopIcons.getState().remove("__file-browser__", api as never);
    await Promise.all([move, remove]);

    expect(useDesktopIcons.getState().icons).toEqual([{ path: "__chat__", x: 240, y: 180 }]);
  });

  it("ignores settings hydration that started before a successful icon write", async () => {
    const api = {
      get: vi.fn(async () => ({ desktopIcons: [CHAT, FILES] })),
      patch: vi.fn(async () => ({ ok: true })),
    };
    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);
    const staleHydrationRevision = captureDesktopIconsHydrationRevision();

    await useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    useDesktopIcons.getState().hydrate([CHAT, FILES], [CHAT, FILES], staleHydrationRevision);

    expect(useDesktopIcons.getState().icons).toContainEqual({ path: "__chat__", x: 240, y: 180 });
  });

  it("ignores settings hydration that overlaps an in-flight icon write", async () => {
    let finishPatch: (() => void) | undefined;
    const api = {
      get: vi.fn(async () => ({ desktopIcons: [CHAT, FILES] })),
      patch: vi.fn(() => new Promise<{ ok: true }>((resolve) => {
        finishPatch = () => resolve({ ok: true });
      })),
    };
    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    const move = useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const staleHydrationRevision = captureDesktopIconsHydrationRevision();
    finishPatch?.();
    await move;
    useDesktopIcons.getState().hydrate([CHAT, FILES], [CHAT, FILES], staleHydrationRevision);

    expect(useDesktopIcons.getState().icons).toContainEqual({ path: "__chat__", x: 240, y: 180 });
  });

  it("defers focus hydration until an in-flight icon write succeeds", async () => {
    let finishPatch: (() => void) | undefined;
    const api = {
      get: vi.fn(async () => ({ desktopIcons: [CHAT, FILES] })),
      patch: vi.fn(() => new Promise<{ ok: true }>((resolve) => {
        finishPatch = () => resolve({ ok: true });
      })),
    };
    await useDesktopIcons.getState().load(api as never, [CHAT, FILES]);

    const move = useDesktopIcons.getState().move("__chat__", 240, 180, api as never);
    await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const overlappingHydrationRevision = captureDesktopIconsHydrationRevision();
    useDesktopIcons.getState().hydrate([CHAT, FILES], [CHAT, FILES], overlappingHydrationRevision);

    expect(useDesktopIcons.getState().icons).toContainEqual({ path: "__chat__", x: 240, y: 180 });

    finishPatch?.();
    await move;

    expect(useDesktopIcons.getState().icons).toContainEqual({ path: "__chat__", x: 240, y: 180 });
  });
});
