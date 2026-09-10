import type { ElectronApplication } from "playwright";

export async function closeElectronApp(app: ElectronApplication, timeoutMs = 5_000): Promise<void> {
  const process = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const graceful = await Promise.race([
      app.close().then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (graceful) return;
  } finally { clearTimeout(timer); }
  if (process.exitCode !== null || process.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    const onExit = () => { clearTimeout(exitTimer); resolve(); };
    const exitTimer = setTimeout(() => {
      process.removeListener("exit", onExit);
      reject(new Error("Electron test process did not exit"));
    }, timeoutMs);
    process.once("exit", onExit);
    process.kill("SIGKILL");
  });
}
