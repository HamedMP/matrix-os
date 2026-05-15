import { readFile } from "node:fs/promises";
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
    expect(restore).toContain("systemctl start $MESSAGING_SERVICES");
    expect(restore).toContain("psql --set ON_ERROR_STOP=1");
    expect(restore).toContain("restore_matrix_os_database");
    expect(restore).toContain("TRUNCATE TABLE");
    expect(restore).toContain("messaging_event_cursors");
    expect(restore).toContain("messaging_hermes_work_items");
    expect(restore).toContain("tar -C \"$ROOT\" -xzf \"$BACKUP_DIR/$name.tar.gz\"");
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
});
