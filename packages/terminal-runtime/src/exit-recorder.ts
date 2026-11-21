import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const TAB_NAME = /^matrix-tab-[0-9a-f]{32}$/;
const TEMP_NAME = /^matrix-tab-[0-9a-f]{32}\.tmp$/;
/** A temporary file this old was left by a write that never finished. */
const ABANDONED_TEMP_MS = 10 * 60_000;
/** Most exit files one pass reads; the rest wait for the next pass. */
const MAX_FILES_PER_PASS = 1_024;
const MAX_FILE_BYTES = 16;

/**
 * Runs a command tab's program under `/bin/sh`, which writes the program's exit
 * code to `<directory>/<zellij tab name>` when it ends. Zellij keeps a command
 * pane after its program exits and reports that only through `list-panes`,
 * which redraws every attached client; reading these files needs no Zellij call.
 *
 * The shell catches INT and QUIT with a no-op, so Ctrl-C reaches the program
 * (whose handlers reset to the default on exec) without ending the recorder.
 * The code is written to a temporary name and renamed, so a reader never sees a
 * partial file.
 */
const RECORDER_SCRIPT = 'f=$1; shift; trap : INT QUIT; "$@"; c=$?; printf "%s\\n" "$c" > "$f.tmp" && mv -f "$f.tmp" "$f"; exit "$c"';

export interface TerminalExitRecord {
  zellijTabName: string;
  exitCode: number;
}

export class TerminalExitRecorder {
  private readonly directory: string;

  private readonly now: () => number;

  constructor(options: { directory: string; now?: () => number }) {
    this.directory = options.directory;
    this.now = options.now ?? Date.now;
  }

  /** Creates the directory, private to the owner. */
  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  /** The command to give Zellij in place of `command`. */
  wrap(zellijTabName: string, command: readonly string[]): string[] {
    return ["/bin/sh", "-c", RECORDER_SCRIPT, "matrix-exit", this.path(zellijTabName), ...command];
  }

  /** Removes a file left by an earlier run of the same tab, before it starts again. */
  async clear(zellijTabName: string): Promise<void> {
    await this.remove(zellijTabName);
  }

  /** The exit codes written so far. Unknown names, symlinks and bad contents are skipped. */
  async read(): Promise<TerminalExitRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const name of names.filter((entry) => TEMP_NAME.test(entry)).slice(0, MAX_FILES_PER_PASS)) {
      await this.removeAbandonedTemp(join(this.directory, name));
    }
    const records: TerminalExitRecord[] = [];
    for (const name of names.filter((entry) => TAB_NAME.test(entry)).slice(0, MAX_FILES_PER_PASS)) {
      const exitCode = await this.readCode(join(this.directory, name));
      if (exitCode !== null) records.push({ zellijTabName: name, exitCode });
    }
    return records;
  }

  /** Removes a tab's exit file and any temporary file its write left. */
  async remove(zellijTabName: string): Promise<void> {
    const path = this.path(zellijTabName);
    await rm(path, { force: true });
    await rm(`${path}.tmp`, { force: true });
  }

  /**
   * A write interrupted between `printf` and `mv` leaves `<name>.tmp`. Each pass
   * removes ones older than ten minutes. `lstat` never follows a link, and a
   * link or other non-file under that name is removed itself (only the entry,
   * never its target): the recorder only ever writes regular files.
   */
  private async removeAbandonedTemp(path: string): Promise<void> {
    const info = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!info || info.isDirectory()) return;
    if (info.isFile() && this.now() - info.mtimeMs < ABANDONED_TEMP_MS) return;
    await rm(path, { force: true });
  }

  private path(zellijTabName: string): string {
    if (!TAB_NAME.test(zellijTabName)) throw new Error("Invalid terminal tab name");
    return join(this.directory, zellijTabName);
  }

  private async readCode(path: string): Promise<number | null> {
    // O_NOFOLLOW: a symlink planted under a tab's name is never followed.
    // O_NONBLOCK: a named pipe opens at once instead of waiting for a writer,
    // and the regular-file check below rejects it.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP") return null;
      throw error;
    });
    if (!handle) return null;
    try {
      if (!(await handle.stat()).isFile()) return null;
      const buffer = Buffer.alloc(MAX_FILE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (!/^\d{1,3}$/.test(text)) return null;
      const exitCode = Number(text);
      return exitCode <= 255 ? exitCode : null;
    } finally {
      await handle.close();
    }
  }
}
