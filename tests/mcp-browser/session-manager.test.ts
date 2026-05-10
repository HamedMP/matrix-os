import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../../packages/mcp-browser/src/session-manager.js";

function createMockPage() {
  return {
    goto: vi.fn().mockResolvedValue({ status: vi.fn().mockReturnValue(200) }),
    title: vi.fn().mockResolvedValue("Test Page"),
    url: vi.fn().mockReturnValue("https://example.com"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    pdf: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
    content: vi.fn().mockResolvedValue("<html><body>Hello</body></html>"),
    evaluate: vi.fn().mockResolvedValue("text"),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    setDefaultTimeout: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    accessibility: { snapshot: vi.fn().mockResolvedValue({ role: "document", name: "Test", children: [] }) },
    on: vi.fn(),
  };
}

function createMockBrowser(page: ReturnType<typeof createMockPage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    contexts: vi.fn().mockReturnValue([]),
  };
}

function createMockLauncher(browser: ReturnType<typeof createMockBrowser>) {
  return vi.fn().mockResolvedValue(browser);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SessionManager", () => {
  let profileRoot: string;
  let mockPage: ReturnType<typeof createMockPage>;
  let mockBrowser: ReturnType<typeof createMockBrowser>;
  let launcher: ReturnType<typeof createMockLauncher>;
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    profileRoot = mkdtempSync(join(tmpdir(), "browser-profiles-"));
    mockPage = createMockPage();
    mockBrowser = createMockBrowser(mockPage);
    launcher = createMockLauncher(mockBrowser);
    manager = new SessionManager({ launcher: launcher as never, idleTimeoutMs: 5000, profileRoot });
  });

  afterEach(async () => {
    await manager.close();
    rmSync(profileRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("launch() creates a new browser session", async () => {
    const session = await manager.launch();
    expect(session).toBeDefined();
    expect(session.page).toBeDefined();
    expect(session.profile).toBe("default");
    expect(session.profilePath).toBe(join(profileRoot, "default"));
    expect(existsSync(join(profileRoot, "default"))).toBe(true);
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(launcher).toHaveBeenCalledWith(expect.objectContaining({
      headless: true,
      userDataDir: join(profileRoot, "default"),
    }));
  });

  it("getActive() returns current session", async () => {
    expect(manager.getActive()).toBeUndefined();
    await manager.launch();
    expect(manager.getActive()).toBeDefined();
  });

  it("close() shuts down browser", async () => {
    await manager.launch();
    await manager.close();
    expect(mockBrowser.close).toHaveBeenCalled();
    expect(manager.getActive()).toBeUndefined();
  });

  it("auto-closes after idle timeout", async () => {
    await manager.launch();
    expect(manager.getActive()).toBeDefined();
    vi.advanceTimersByTime(5001);
    await vi.runAllTimersAsync();
    expect(manager.getActive()).toBeUndefined();
  });

  it("resets idle timer on activity", async () => {
    await manager.launch();
    vi.advanceTimersByTime(3000);
    manager.touch();
    vi.advanceTimersByTime(3000);
    expect(manager.getActive()).toBeDefined();
    vi.advanceTimersByTime(2001);
    await vi.runAllTimersAsync();
    expect(manager.getActive()).toBeUndefined();
  });

  it("only allows one session at a time", async () => {
    await manager.launch();
    await manager.launch();
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it("launches named profiles in stable user data directories", async () => {
    const session = await manager.launch({ profile: "work" });
    expect(session.profile).toBe("work");
    expect(session.profilePath).toBe(join(profileRoot, "work"));
    expect(launcher).toHaveBeenCalledWith(expect.objectContaining({
      userDataDir: join(profileRoot, "work"),
    }));
  });

  it("switches profiles by closing the active browser first", async () => {
    const secondPage = createMockPage();
    const secondBrowser = createMockBrowser(secondPage);
    launcher.mockResolvedValueOnce(mockBrowser).mockResolvedValueOnce(secondBrowser);

    await manager.launch({ profile: "work" });
    await manager.launch({ profile: "personal" });

    expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(manager.getActive()?.profile).toBe("personal");
  });

  it("serializes concurrent launches for different profiles", async () => {
    const secondPage = createMockPage();
    const secondBrowser = createMockBrowser(secondPage);
    const firstLaunch = deferred<typeof mockBrowser>();
    launcher.mockReset();
    launcher.mockImplementationOnce(() => firstLaunch.promise);
    launcher.mockResolvedValueOnce(secondBrowser);

    const workLaunch = manager.launch({ profile: "work" });
    await vi.waitFor(() => expect(launcher).toHaveBeenCalledTimes(1));

    const personalLaunch = manager.launch({ profile: "personal" });
    await Promise.resolve();
    expect(launcher).toHaveBeenCalledTimes(1);

    firstLaunch.resolve(mockBrowser);
    const [workSession, personalSession] = await Promise.all([workLaunch, personalLaunch]);

    expect(workSession.profile).toBe("work");
    expect(personalSession.profile).toBe("personal");
    expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    expect(launcher).toHaveBeenCalledTimes(2);
    expect(manager.getActive()?.profile).toBe("personal");
  });

  it("rejects invalid profile names before launching", async () => {
    await expect(manager.launch({ profile: "../secrets" })).rejects.toThrow(
      "Invalid browser profile name",
    );
    expect(launcher).not.toHaveBeenCalled();
  });

  it("lazy start: no browser process until first launch", () => {
    expect(launcher).not.toHaveBeenCalled();
    expect(manager.getActive()).toBeUndefined();
  });
});
