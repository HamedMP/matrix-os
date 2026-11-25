import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("customer VPS messaging backup and restore helpers", () => {
  it("backs up homeserver, bridge DBs, mappings, and permission tables", async () => {
    const backup = await readFile("distro/customer-vps/host-bin/matrix-messaging-backup", "utf8");

    expect(backup).toContain("synapse");
    expect(backup).toContain("mautrix-telegram");
    expect(backup).toContain("mautrix-whatsapp");
    expect(backup).toContain("messaging_permissions");
    expect(backup).toContain("messaging_conversation_mappings");
    expect(backup).toContain("messaging_event_cursors");
    expect(backup).toContain("messaging_hermes_work_items");
    expect(backup).toContain("messaging_audit_events");
    expect(backup).toContain("--data-only");
    expect(backup).toContain("--column-inserts");
    expect(backup).toContain("--clean --if-exists");
    expect(backup).toContain("MATRIX_HOST_ENV_FILE");
    expect(backup).toContain("/opt/matrix/env/host.env");
    expect(backup).toContain("MATRIX_MESSAGING_ENV_FILE");
    expect(backup).toContain("load_env_file \"$HOST_ENV_FILE\"");
    expect(backup).toContain("load_env_file \"$MESSAGING_ENV_FILE\"");
    expect(backup).toContain("systemctl stop $MESSAGING_SERVICES");
    expect(backup).toContain("trap restart_services EXIT INT TERM");
    expect(backup).toContain("systemctl start $MESSAGING_SERVICES");
    expect(backup).toContain("SYNAPSE_DATABASE_URL");
    expect(backup).toContain("MAUTRIX_TELEGRAM_DATABASE_URL");
    expect(backup).toContain("MAUTRIX_WHATSAPP_DATABASE_URL");
    expect(backup).toContain("dump_database synapse-db");
    expect(backup).toContain("dump_database mautrix-whatsapp-db");
  });

  it("restore helper reports WhatsApp relink when backups are stale", async () => {
    const restore = await readFile("distro/customer-vps/host-bin/matrix-messaging-restore", "utf8");

    expect(restore).toContain("WHATSAPP_RELINK_AFTER_HOURS=24");
    expect(restore).toContain("relink_required");
    expect(restore).toContain("RTO_MINUTES=15");
    expect(restore).toContain("MATRIX_MESSAGING_ENV_FILE");
    expect(restore).toContain("MATRIX_HOST_ENV_FILE");
    expect(restore).toContain("/opt/matrix/env/host.env");
    expect(restore).toContain("load_env_file \"$HOST_ENV_FILE\"");
    expect(restore).toContain("load_env_file \"$MESSAGING_ENV_FILE\"");
    expect(restore).toContain("systemctl stop $MESSAGING_SERVICES");
    expect(restore).toContain("trap restart_services EXIT INT TERM");
    expect(restore).toContain("systemctl start $MESSAGING_SERVICES");
    expect(restore).toContain("psql --set ON_ERROR_STOP=1 --single-transaction");
    expect(restore).toContain("restore_matrix_os_database");
    expect(restore).toContain("TRUNCATE TABLE");
    expect(restore).toContain('-c "$MATRIX_OS_TRUNCATE_SQL"');
    expect(restore).toContain("-f \"$file\"");
    expect(restore).toContain("messaging_event_cursors");
    expect(restore).toContain("messaging_hermes_work_items");
    expect(restore).toContain("restore_tree()");
    expect(restore).toContain("tar -C \"$tmp\" -xzf \"$archive\"");
    expect(restore).toContain("mv \"$ROOT/$name\" \"$old\"");
    expect(restore).toContain("mv \"$tmp/$name\" \"$ROOT/$name\"");
    expect(restore).toContain("restore_database synapse-db");
    expect(restore).toContain("restore_database mautrix-telegram-db");
    expect(restore).toContain("restore_database mautrix-whatsapp-db");
  });

  it("documents the generic data root default and volume override", async () => {
    const docs = await readFile("docs/platform/dev/messaging-bridge.md", "utf8");

    expect(docs).toContain("/var/lib/matrix-messaging");
    expect(docs).toContain("/etc/matrix/messaging.env");
    expect(docs).not.toContain("HC_Volume_104683898");
  });

  it("health helper emits single-token service states for JSON output", async () => {
    const health = await readFile("distro/customer-vps/host-bin/matrix-messaging-health", "utf8");

    expect(health).toContain("systemctl is-active --quiet");
    expect(health).toContain("printf active");
    expect(health).toContain("printf unknown");
    expect(health).not.toContain("systemctl is-active \"$1\" 2>/dev/null || printf unknown");
  });

  it("backs up the bridge message store and sync position, not the removed setup sessions", async () => {
    const backup = await readFile("distro/customer-vps/host-bin/matrix-messaging-backup", "utf8");
    expect(backup).toContain("--table=messaging_messages");
    expect(backup).toContain("--table=messaging_bridge_sync_state");
    expect(backup).not.toContain("messaging_setup_sessions");
  });

  it("restore empties every messaging table that exists and skips tables the schema lacks", async () => {
    const restore = await readFile("distro/customer-vps/host-bin/matrix-messaging-restore", "utf8");
    const block = /# BEGIN MATRIX_OS_TRUNCATE_SQL\nMATRIX_OS_TRUNCATE_SQL='([\s\S]*?)'\n# END MATRIX_OS_TRUNCATE_SQL/.exec(restore);
    expect(block).not.toBeNull();
    const truncateSql = block![1]!;
    expect(truncateSql).not.toContain("'");

    const db = new PGlite();
    try {
      // A fresh database with only some of the tables, one of them referenced by another.
      await db.exec(`
        CREATE TABLE messaging_accounts (id TEXT PRIMARY KEY);
        CREATE TABLE messaging_messages (id TEXT PRIMARY KEY, account_id TEXT REFERENCES messaging_accounts(id));
        CREATE TABLE messaging_bridge_sync_state (owner_id TEXT PRIMARY KEY);
        CREATE TABLE unrelated (id TEXT PRIMARY KEY);
        INSERT INTO messaging_accounts VALUES ('a');
        INSERT INTO messaging_messages VALUES ('m', 'a');
        INSERT INTO messaging_bridge_sync_state VALUES ('o');
        INSERT INTO unrelated VALUES ('u');
      `);
      await db.exec(truncateSql);
      for (const table of ["messaging_accounts", "messaging_messages", "messaging_bridge_sync_state"]) {
        expect((await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count, table).toBe(0);
      }
      expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM unrelated")).rows[0]?.count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("restores a backup taken before setup sessions were removed into a database that still has them", async () => {
    const restore = await readFile("distro/customer-vps/host-bin/matrix-messaging-restore", "utf8");
    const truncateSql = /# BEGIN MATRIX_OS_TRUNCATE_SQL\nMATRIX_OS_TRUNCATE_SQL='([\s\S]*?)'\n# END MATRIX_OS_TRUNCATE_SQL/.exec(restore)![1]!;
    const db = new PGlite();
    try {
      // An upgraded home keeps the old table and its rows; the old backup contains the same rows.
      await db.exec(`
        CREATE TABLE messaging_accounts (id TEXT PRIMARY KEY);
        -- As the 077 schema created it: no foreign key, so truncating accounts does not cascade.
        CREATE TABLE messaging_setup_sessions (id TEXT PRIMARY KEY, account_id TEXT);
        INSERT INTO messaging_accounts VALUES ('a');
        INSERT INTO messaging_setup_sessions VALUES ('setup_1', 'a');
      `);
      const oldBackup = "INSERT INTO messaging_accounts VALUES ('a'); INSERT INTO messaging_setup_sessions VALUES ('setup_1', 'a');";
      await db.exec(`BEGIN; ${truncateSql} ${oldBackup} COMMIT;`);
      expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM messaging_setup_sessions")).rows[0]?.count).toBe(1);
    } finally {
      await db.close();
    }
  });
});
