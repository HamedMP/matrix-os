import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createAnalyticsBeforeQuit } from "@desktop/main/analytics-quit";

describe("bounded Desktop analytics quit", () => {
  it("waits for renderer flush once and then re-enters the normal quit path", async () => {
    let finishFlush: (() => void) | undefined;
    const requestFlush = vi.fn(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    const quit = vi.fn();
    const handler = createAnalyticsBeforeQuit({ requestFlush, quit, timeoutMs: 50 });
    const firstEvent = { preventDefault: vi.fn() };

    handler(firstEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(requestFlush).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    finishFlush?.();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    const reenteredEvent = { preventDefault: vi.fn() };
    handler(reenteredEvent);
    expect(reenteredEvent.preventDefault).not.toHaveBeenCalled();
    expect(requestFlush).toHaveBeenCalledOnce();
  });

  it("continues quitting when renderer flush stalls", async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const handler = createAnalyticsBeforeQuit({
      requestFlush: vi.fn(() => new Promise<void>(() => undefined)),
      quit,
      timeoutMs: 750,
    });

    handler({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(749);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(quit).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("contains renderer flush rejection and still quits", async () => {
    const quit = vi.fn();
    const handler = createAnalyticsBeforeQuit({
      requestFlush: vi.fn(async () => { throw new Error("renderer private failure"); }),
      quit,
      timeoutMs: 50,
    });

    handler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  it("keeps Terminal available until the application actually quits", () => {
    const source = ts.createSourceFile(
      "index.ts",
      readFileSync(new URL("../../desktop/src/main/index.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const registrations: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "app.on") {
        const [event] = node.arguments;
        if (ts.isStringLiteral(event) && ["before-quit", "will-quit"].includes(event.text)) {
          registrations.push(node.getText(source));
        }
      }
      node.forEachChild(visit);
    }
    visit(source);
    const listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
    const dispose = vi.fn();
    const releaseAll = vi.fn();
    const app = { on: (name: string, listener: typeof listeners[string]) => { listeners[name] = listener; } };
    const { outputText } = ts.transpileModule(`
      const organizationDriveTransfers = null, nativeAppChatNavigation = null, handleAnalyticsBeforeQuit = null;
      const navigationCache = null, navigationCacheDrained = true, planDrained = true;
      const planDiagnosticsDrained = true, importsDrained = true, downloadsDrained = true;
      const handleUpdateBeforeQuit = null;
      let updateCheckTimer, closeCodingAgentThreadEvents, shortcutWiring, computerCredentials;
      let terminalWindows = { dispose }, localTerminals = { dispose }, localTerminalStreams = { releaseAll };
      ${registrations.join(";\n")}
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
    new Function("app", "dispose", "releaseAll", outputText)(app, dispose, releaseAll);

    const event = { preventDefault: vi.fn() };
    listeners["before-quit"](event);
    expect(dispose).not.toHaveBeenCalled();
    expect(releaseAll).not.toHaveBeenCalled();

    listeners["will-quit"](event);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(releaseAll).toHaveBeenCalledOnce();
  });
});
