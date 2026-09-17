import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(process.cwd(), "distro/customer-vps/matrix-db-backup.sh");

describe("matrix database backup script", () => {
  let root: string;
  let bin: string;
  let snapshots: string;
  let statusDir: string;
  let store: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "matrix-db-backup-"));
    bin = join(root, "bin");
    snapshots = join(root, "snapshots");
    statusDir = join(root, "status");
    store = join(root, "store");
    await Promise.all([bin, snapshots, statusDir, store].map((path) => mkdir(path, { recursive: true })));
    const pgDump = join(bin, "pg_dump");
    await writeFile(pgDump, `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in --file=*) target="\${arg#--file=}" ;; esac
done
printf 'synthetic-postgres-dump' > "$target"
`);
    await chmod(pgDump, 0o755);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeMatrixctl(failUpload = false): Promise<string> {
    const path = join(bin, "matrixctl");
    await writeFile(path, `#!/usr/bin/env bash
set -euo pipefail
store="${store}"
[ "$1" = r2 ]
case "$2" in
  put)
    ${failUpload ? "exit 9" : ":"}
    mkdir -p "$store/$(dirname "$4")"
    cp "$3" "$store/$4"
    ;;
  exists)
    test -f "$store/$3"
    ;;
  put-latest)
    mkdir -p "$store/system/db"
    printf '%s\n' "$3" > "$store/system/db/latest"
    ;;
  get)
    cp "$store/$3" "$4"
    ;;
  *) exit 2 ;;
esac
`);
    await chmod(path, 0o755);
    return path;
  }

  function run(matrixctl: string) {
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        POSTGRES_PASSWORD: "synthetic",
        MATRIX_DB_SNAPSHOT_DIR: snapshots,
        MATRIX_DB_BACKUP_STATUS_DIR: statusDir,
        MATRIX_DB_BACKUP_LOCK_FILE: join(root, "backup.lock"),
        MATRIX_DB_BACKUP_MIN_FREE_KB: "0",
        MATRIXCTL_BIN: matrixctl,
        PG_DUMP_BIN: join(bin, "pg_dump"),
        MATRIX_POSTGRES_ENV_FILE: join(root, "missing-postgres.env"),
      },
    });
  }

  it("marks success only after snapshot, receipt, and latest pointer verification", async () => {
    const result = run(await writeMatrixctl());
    expect(result.status, result.stderr).toBe(0);

    const attempt = JSON.parse(await readFile(join(statusDir, "last-attempt.json"), "utf8"));
    const success = JSON.parse(await readFile(join(statusDir, "last-success.json"), "utf8"));
    expect(attempt).toMatchObject({ outcome: "success", errorCode: null });
    expect(success).toMatchObject({
      runtimeSlot: "primary",
      restoreVerifiedAt: null,
    });
    expect(success.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(success.size).toBeGreaterThan(0);
    await expect(readFile(join(store, success.snapshotKey))).resolves.toBeTruthy();
    await expect(readFile(join(store, success.receiptKey), "utf8")).resolves.toContain(success.sha256);
    await expect(readFile(join(store, "system/db/latest"), "utf8")).resolves.toBe(`${success.snapshotKey}\n`);
    expect((await stat(join(statusDir, "last-success.json"))).mode & 0o777).toBe(0o600);
  });

  it("records a coarse failure without replacing prior success evidence", async () => {
    const first = run(await writeMatrixctl());
    expect(first.status, first.stderr).toBe(0);
    const prior = await readFile(join(statusDir, "last-success.json"), "utf8");

    const failed = run(await writeMatrixctl(true));
    expect(failed.status).not.toBe(0);
    expect(JSON.parse(await readFile(join(statusDir, "last-attempt.json"), "utf8")))
      .toMatchObject({ outcome: "failed", errorCode: "storage_upload_failed" });
    await expect(readFile(join(statusDir, "last-success.json"), "utf8")).resolves.toBe(prior);
  });
});
