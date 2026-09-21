// @vitest-environment jsdom
/**
 * S06 / T033, T034: Electron Desktop uses the same direct client as the web
 * shells, identifies itself with the platform origin (the renderer is not an
 * https origin), and ends its home sessions when the desktop auth changes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const created: unknown[] = [];
vi.mock("@matrix-os/ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@matrix-os/ui")>();
  return {
    ...original,
    createCollaborationDirectApi: vi.fn((options: unknown) => {
      created.push(options);
      return { baseUrl: "https://app.matrix-os.com", direct: { close: vi.fn(), describe: vi.fn() } };
    }),
  };
});

import { closeDesktopCollaborationSessions, createDesktopCollaborationApi } from "@desktop/renderer/src/lib/collaboration";

describe("desktop direct collaboration wiring", () => {
  afterEach(() => { created.length = 0; closeDesktopCollaborationSessions(); });

  it("presents the platform origin as the client origin and shares the web direct client", () => {
    const api = createDesktopCollaborationApi("https://app.matrix-os.com");
    expect(api).not.toBeNull();
    expect(created[0]).toEqual({ platformBaseUrl: "https://app.matrix-os.com", clientOrigin: "https://app.matrix-os.com" });
    expect(createDesktopCollaborationApi("")).toBeNull();
    expect(createDesktopCollaborationApi("not a url")).toBeNull();
  });

  it("closes every renderer session on demand and tolerates repeated closes", () => {
    const first = createDesktopCollaborationApi("https://app.matrix-os.com")!;
    const second = createDesktopCollaborationApi("https://app.matrix-os.com")!;
    closeDesktopCollaborationSessions();
    expect(first.direct.close).toHaveBeenCalledTimes(1);
    expect(second.direct.close).toHaveBeenCalledTimes(1);
    closeDesktopCollaborationSessions();
    expect(first.direct.close).toHaveBeenCalledTimes(1);
  });
});
