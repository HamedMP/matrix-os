import { beforeEach, describe, expect, it, vi } from "vitest";

class TestModel {
  private value: string;
  private disposed = false;

  constructor(value: string) {
    this.value = value;
  }

  getValue() {
    return this.value;
  }

  setValue(value: string) {
    this.value = value;
  }

  dispose() {
    this.disposed = true;
  }

  isDisposed() {
    return this.disposed;
  }
}

vi.mock("monaco-editor", () => ({
  editor: {
    defineTheme: vi.fn(),
    createModel: vi.fn((content: string) => new TestModel(content)),
  },
  Uri: {
    file: vi.fn((path: string) => ({ path })),
  },
}));

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({ default: class Worker {} }));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({ default: class Worker {} }));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({ default: class Worker {} }));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({ default: class Worker {} }));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({ default: class Worker {} }));

async function loadMonacoSetup() {
  vi.resetModules();
  (globalThis as { self?: unknown }).self = {};
  return import("../../desktop/src/renderer/src/features/editor/monaco-setup");
}

describe("monaco model cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not evict models with unsaved edits when the cache is full", async () => {
    const { getOrCreateModel } = await loadMonacoSetup();
    const dirty = getOrCreateModel("task-a", "dirty.ts", "server-value");
    dirty.setValue("unsaved-value");

    for (let i = 0; i < 32; i += 1) {
      getOrCreateModel("task-a", `clean-${i}.ts`, `clean-${i}`);
    }

    expect(dirty.isDisposed()).toBe(false);
    expect(getOrCreateModel("task-a", "dirty.ts", "server-value").getValue()).toBe("unsaved-value");
  });

  it("does not advance a dirty model baseline on cache hit", async () => {
    const { getOrCreateModel } = await loadMonacoSetup();
    const dirty = getOrCreateModel("task-a", "dirty.ts", "server-value");
    dirty.setValue("unsaved-value");

    expect(getOrCreateModel("task-a", "dirty.ts", "unsaved-value").getValue()).toBe("unsaved-value");

    for (let i = 0; i < 32; i += 1) {
      getOrCreateModel("task-a", `clean-${i}.ts`, `clean-${i}`);
    }

    expect(dirty.isDisposed()).toBe(false);
  });

  it("isolates same-path dirty models by task", async () => {
    const { getOrCreateModel } = await loadMonacoSetup();
    const taskA = getOrCreateModel("task-a", "src/app.ts", "server-a");
    taskA.setValue("task-a unsaved");

    const taskB = getOrCreateModel("task-b", "src/app.ts", "server-b");

    expect(taskB).not.toBe(taskA);
    expect(taskB.getValue()).toBe("server-b");
    expect(getOrCreateModel("task-a", "src/app.ts", "server-a").getValue()).toBe("task-a unsaved");
  });
});
