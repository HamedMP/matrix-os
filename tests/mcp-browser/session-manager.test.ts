import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("SessionManager", () => {
  let mockPage: ReturnType<typeof createMockPage>;
  let mockBrowser: ReturnType<typeof createMockBrowser>;
  let launcher: ReturnType<typeof createMockLauncher>;
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPage = createMockPage();
    mockBrowser = createMockBrowser(mockPage);
    launcher = createMockLauncher(mockBrowser);
    manager = new SessionManager({ launcher: launcher as never, idleTimeoutMs: 5000 });
  });

  afterEach(async () => {
    await manager.close();
    vi.useRealTimers();
  });

  it("launch() creates a new browser session", async () => {
    const session = await manager.launch();
    expect(session).toBeDefined();
    expect(session.page).toBeDefined();
    expect(launcher).toHaveBeenCalledTimes(1);
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

  it("lazy start: no browser process until first launch", () => {
    expect(launcher).not.toHaveBeenCalled();
    expect(manager.getActive()).toBeUndefined();
  });
});
