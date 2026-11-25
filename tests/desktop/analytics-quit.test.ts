import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createAnalyticsBeforeQuit } from "@desktop/main/analytics-quit";

function registerMacQuitWiring(dependencies: {
  app: { on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void; quit(): void };
  handleAnalyticsBeforeQuit: ReturnType<typeof createAnalyticsBeforeQuit>;
  chatElectronPreview: { cancel(): Promise<void> };
  macTerminalChecks: { cancelAll(): Promise<void> };
  macActivity: { close(): Promise<void> };
  handleUpdateBeforeQuit(): void;
}) {
  // Execute the production composition callbacks without starting Electron.
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../../desktop/src/main/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let quitRegistration: ts.CallExpression | undefined;
  let close: ts.BinaryExpression | undefined;
  const trustedSenders: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const [event, options] = node.arguments;
      if (callee === "app.on" && event && ts.isStringLiteral(event) && event.text === "before-quit") quitRegistration = node;
      if ((callee === "registerChatElectronPreview" || callee === "registerChatMacTerminal") && options && ts.isObjectLiteralExpression(options)) {
        const trust = options.properties.find(prop => ts.isPropertyAssignment(prop) && prop.name.getText(source) === "isTrustedSender");
        if (trust && ts.isPropertyAssignment(trust)) trustedSenders.push(trust.initializer.getText(source));
      }
    }
    if (ts.isBinaryExpression(node) && node.left.getText(source) === "closeMacActivity" && ts.isArrowFunction(node.right)) close = node;
    node.forEachChild(visit);
  }
  visit(source);
  if (!quitRegistration || !close || trustedSenders.length !== 2) throw new Error("Mac quit wiring was not found");
  const { outputText } = ts.transpileModule(`
    const { app, handleAnalyticsBeforeQuit, chatElectronPreview, macTerminalChecks, macActivity, handleUpdateBeforeQuit } = dependencies;
    const organizationDriveTransfers = null, nativeAppChatNavigation = null, cancelDesktopPairing = null;
    const navigationCacheDrained = true, planDrained = true, planDiagnosticsDrained = true, importsDrained = true, downloadsDrained = true;
    let updateCheckTimer, closeCodingAgentThreadEvents, terminalWindows, shortcutWiring, computerCredentials, localTerminals;
    const senderRole = () => "main", windowSenders = {};
    const logMainError = (context, error) => { throw new Error(context, { cause: error }); };
    let closeMacActivity, drainingMacActivity = false;
    ${close.getText(source)};
    ${quitRegistration.getText(source)};
    return [${trustedSenders.join(", ")}];
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  return new Function("dependencies", outputText)(dependencies) as Array<() => boolean>;
}

describe("bounded Desktop analytics quit", () => {
  it("fences Mac IPC and starts both cancellations on the first quit with analytics pending", async () => {
    vi.useFakeTimers();
    try {
      const flush = Promise.withResolvers<void>();
      const requestFlush = vi.fn(() => flush.promise);
      const previewCanceled = Promise.withResolvers<void>();
      const cancel = vi.fn(() => previewCanceled.promise);
      const cancelAll = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const normalQuit = vi.fn();
      let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
      const quit = vi.fn(() => {
        const event = { preventDefault: vi.fn() };
        beforeQuit?.(event);
        return event.preventDefault;
      });
      const senderChecks = registerMacQuitWiring({
        app: { on: (_event, listener) => { beforeQuit = listener; }, quit },
        handleAnalyticsBeforeQuit: createAnalyticsBeforeQuit({ requestFlush, quit, timeoutMs: 750 }),
        chatElectronPreview: { cancel }, macTerminalChecks: { cancelAll }, macActivity: { close },
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
      expect(close).toHaveBeenCalledOnce();
      expect(requestFlush).toHaveBeenCalledOnce();
      expect(normalQuit).not.toHaveBeenCalled();
      expect(senderChecks.map(check => check())).toEqual([false, false]);

      flush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(normalQuit).toHaveBeenCalledOnce();
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
