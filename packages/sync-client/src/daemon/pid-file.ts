import { readFile, unlink, writeFile } from "node:fs/promises";

let acquisitionTail: Promise<void> = Promise.resolve();

export function writePidFileExclusive(filePath: string, pid: number): Promise<void> {
  // Multiple start attempts in one runtime must not race stale-file recovery
  // and unlink a freshly acquired pid file. The filesystem's `wx` create
  // remains the authority across separate processes.
  const acquisition = acquisitionTail.then(() =>
    writePidFileExclusiveNow(filePath, pid),
  );
  acquisitionTail = acquisition.then(
    () => undefined,
    (err: unknown) => {
      // The caller receives the original rejection. The tail only absorbs it
      // so a failed contender cannot poison later acquisition attempts.
      if (!(err instanceof Error)) {
        console.warn("[sync/daemon] PID acquisition rejected with a non-Error value");
      }
    },
  );
  return acquisition;
}

async function writePidFileExclusiveNow(filePath: string, pid: number): Promise<void> {
  const writeExclusive = async () => {
    await writeFile(filePath, String(pid), { flag: "wx" });
  };

  try {
    await writeExclusive();
    return;
  } catch (err: unknown) {
    if (
      !(err instanceof Error) ||
      !("code" in err) ||
      (err as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw err;
    }
  }

  let existingPid: number | null = null;
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = Number.parseInt(raw.trim(), 10);
    existingPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      await writeExclusive();
      return;
    }
    throw err;
  }

  if (existingPid !== null) {
    try {
      process.kill(existingPid, 0);
      throw new Error(`Sync daemon already running (pid ${existingPid})`);
    } catch (err: unknown) {
      if (
        !(err instanceof Error) ||
        !("code" in err) ||
        (err as NodeJS.ErrnoException).code !== "ESRCH"
      ) {
        throw err;
      }
    }
  }

  await unlink(filePath).catch((err: unknown) => {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw err;
  });
  await writeExclusive();
}
