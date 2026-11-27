import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createAnalyticsBeforeQuit } from "@desktop/main/analytics-quit";
import { createMacActivityQuit } from "@desktop/main/mac-activity/quit";

function registerMacQuitWiring(dependencies: {
  app: { on(event: "before-quit" | "will-quit", listener: (event: { preventDefault(): void }) => void): void; quit(): void };
  windows?: [TestWindow, TestWindow];
  localTerminalHost?: { dispose(): void };
  disposeDesktopPairing?: () => void;
  handleAnalyticsBeforeQuit: ReturnType<typeof createAnalyticsBeforeQuit>;
  chatElectronPreview: { cancel(): Promise<void> };
  macTerminalChecks: { cancelAll(): Promise<void> };
  macActivity: { flush(): Promise<void>; close(): Promise<void> };
  handleUpdateBeforeQuit(event: { preventDefault(): void }): void;
}) {
  // Execute the production composition callbacks without starting Electron.
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../../desktop/src/main/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const quitRegistrations: string[] = [];
  const windowWatches: string[] = [];
  let lifecycle: ts.BinaryExpression | undefined;
  const trustedSenders: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const [event, options] = node.arguments;
      if (callee === "app.on" && event && ts.isStringLiteral(event) && ["before-quit", "will-quit"].includes(event.text)) {
        quitRegistrations.push(node.getText(source));
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "watchWindow") {
        windowWatches.push(node.getText(source));
      }
      if ((callee === "registerChatElectronPreview" || callee === "registerChatMacTerminal") && options && ts.isObjectLiteralExpression(options)) {
        const trust = options.properties.find(prop => ts.isPropertyAssignment(prop) && prop.name.getText(source) === "isTrustedSender");
        if (trust && ts.isPropertyAssignment(trust)) trustedSenders.push(trust.initializer.getText(source));
      }
    }
    if (ts.isBinaryExpression(node) && node.left.getText(source) === "macActivityQuit"
      && ts.isCallExpression(node.right) && node.right.expression.getText(source) === "createMacActivityQuit") lifecycle = node;
    node.forEachChild(visit);
  }
  visit(source);
  if (quitRegistrations.length !== 2 || !lifecycle || windowWatches.length !== 2 || trustedSenders.length !== 2) throw new Error("Mac quit wiring was not found");
  const { outputText } = ts.transpileModule(`
    const { app, handleAnalyticsBeforeQuit, chatElectronPreview, macTerminalChecks, macActivity, handleUpdateBeforeQuit } = dependencies;
    const organizationDriveTransfers = null, nativeAppChatNavigation = null, cancelDesktopPairing = null;
    const disposeDesktopPairing = dependencies.disposeDesktopPairing;
    const navigationCacheDrained = true, planDrained = true, planDiagnosticsDrained = true, importsDrained = true, downloadsDrained = true;
    const installedAppsDrained = true, installedApps = null, drainingInstalledApps = false, disposeMainWindowActions = null;
    let updateCheckTimer, closeCodingAgentThreadEvents, terminalWindows, shortcutWiring, computerCredentials, localTerminalStreams = null;
    let localTerminals = dependencies.localTerminalHost;
    const senderRole = () => "main", windowSenders = {};
    const logMainError = (context, error) => { throw new Error(context, { cause: error }); };
    let macActivityQuit;
    ${lifecycle.getText(source)};
    ${quitRegistrations.join(";\n")};
    if (dependencies.windows) {
      const [main, terminal] = dependencies.windows;
      { const win = main; ${windowWatches[0]}; }
      { const win = terminal; ${windowWatches[1]}; }
    }
    return [${trustedSenders.join(", ")}];
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  return new Function("dependencies", "createMacActivityQuit", outputText)(dependencies, createMacActivityQuit) as Array<() => boolean>;
}

class TestWindow extends EventEmitter {
  webContents = new EventEmitter();
}

describe("bounded Desktop analytics quit", () => {
  it.each(["main", "terminal"] as const)("restores Mac IPC after the %s window vetoes quit", async (vetoWindow) => {
    vi.useFakeTimers();
    try {
      const main = new TestWindow();
      const terminal = new TestWindow();
      const windows: [TestWindow, TestWindow] = [main, terminal];
      const veto = vetoWindow === "main" ? main : terminal;
      const cancellation = Promise.withResolvers<void>();
      const secondCancellation = Promise.withResolvers<void>();
      const flush = Promise.withResolvers<void>();
      const cancel = vi.fn(() => secondCancellation.promise).mockReturnValueOnce(cancellation.promise);
      const cancelAll = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const terminalHost = { dispose: vi.fn() };
      const disposeDesktopPairing = vi.fn();
      const app = new EventEmitter();
      const unloadEvent = { preventDefault: vi.fn(), defaultPrevented: false };
      let shouldVeto = true;
      let updatePending = vetoWindow === "main";
      const quit = vi.fn(() => {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        app.emit("before-quit", event);
        if (event.defaultPrevented) return;
        for (const win of windows) win.emit("close", { defaultPrevented: false });
        if (shouldVeto) veto.webContents.emit("will-prevent-unload", unloadEvent);
        else app.emit("will-quit", event);
      });
      const senderChecks = registerMacQuitWiring({
        app: Object.assign(app, { quit }),
        windows, localTerminalHost: terminalHost, disposeDesktopPairing,
        handleAnalyticsBeforeQuit: createAnalyticsBeforeQuit({ requestFlush: () => flush.promise, quit, timeoutMs: 750 }),
        chatElectronPreview: { cancel }, macTerminalChecks: { cancelAll }, macActivity: { close, flush: vi.fn(async () => {}) },
        handleUpdateBeforeQuit(event) {
          if (!updatePending) return;
          updatePending = false;
          event.preventDefault();
        },
      });
      const admission = () => senderChecks.map(check => check());

      quit();
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancelAll).toHaveBeenCalledOnce();
      expect(admission()).toEqual([false, false]);
      veto.webContents.emit("will-prevent-unload", unloadEvent);
      expect(admission()).toEqual([false, false]);

      if (vetoWindow === "main") cancellation.resolve();
      await vi.advanceTimersByTimeAsync(vetoWindow === "main" ? 0 : 5_000);
      veto.webContents.emit("will-prevent-unload", unloadEvent);
      expect(admission()).toEqual([false, false]);

      flush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (vetoWindow === "main") {
        // An installer-held quit has not initiated Electron window closure.
        main.emit("close", { defaultPrevented: false });
        main.webContents.emit("will-prevent-unload", unloadEvent);
        await vi.advanceTimersByTimeAsync(0);
        expect(admission()).toEqual([false, false]);
        quit();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(admission()).toEqual([true, true]);
      expect(unloadEvent.preventDefault).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(terminalHost.dispose).not.toHaveBeenCalled();
      expect(disposeDesktopPairing).not.toHaveBeenCalled();

      shouldVeto = false;
      quit();
      expect(admission()).toEqual([false, false]);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancelAll).toHaveBeenCalledTimes(2);
      const replayCount = quit.mock.calls.length;
      cancellation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(quit).toHaveBeenCalledTimes(replayCount);
      expect(admission()).toEqual([false, false]);

      secondCancellation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
      expect(terminalHost.dispose).toHaveBeenCalledOnce();
      expect(disposeDesktopPairing).toHaveBeenCalledOnce();
      veto.webContents.emit("will-prevent-unload", unloadEvent);
      expect(admission()).toEqual([false, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences Mac IPC and starts both cancellations on the first quit with analytics pending", async () => {
    vi.useFakeTimers();
    try {
      const flush = Promise.withResolvers<void>();
      const requestFlush = vi.fn(() => flush.promise);
      const previewCanceled = Promise.withResolvers<void>();
      const cancel = vi.fn(() => previewCanceled.promise);
      const cancelAll = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const flushHistory = vi.fn(async () => undefined);
      const normalQuit = vi.fn();
      const app = new EventEmitter();
      const quit = vi.fn(() => {
        const event = { defaultPrevented: false, preventDefault: vi.fn(() => { event.defaultPrevented = true; }) };
        app.emit("before-quit", event);
        if (!event.defaultPrevented) app.emit("will-quit", event);
        return event.preventDefault;
      });
      const senderChecks = registerMacQuitWiring({
        app: Object.assign(app, { quit }),
        handleAnalyticsBeforeQuit: createAnalyticsBeforeQuit({ requestFlush, quit, timeoutMs: 750 }),
        chatElectronPreview: { cancel }, macTerminalChecks: { cancelAll }, macActivity: { close, flush: flushHistory },
        handleUpdateBeforeQuit: normalQuit,
      });

      expect(senderChecks.map(check => check())).toEqual([true, true]);
      expect(quit()).toHaveBeenCalledOnce();
      expect(senderChecks.map(check => check())).toEqual([false, false]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancelAll).toHaveBeenCalledOnce();
      expect(quit()).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancelAll).toHaveBeenCalledOnce();

      previewCanceled.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(flushHistory).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(requestFlush).toHaveBeenCalledOnce();
      expect(normalQuit).not.toHaveBeenCalled();
      expect(senderChecks.map(check => check())).toEqual([false, false]);

      flush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(normalQuit).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancelAll).toHaveBeenCalledOnce();
      expect(requestFlush).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

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
});
