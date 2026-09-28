import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const syncAgent = readFileSync("distro/customer-vps/host-bin/matrix-sync-agent", "utf8");
const recovery = readFileSync("distro/customer-vps/host-bin/matrix-sync-agent-recovery", "utf8");
const bundle = readFileSync("scripts/build-host-bundle.sh", "utf8");

describe("retiring the legacy Symphony runtime", () => {
  it("stops and disables an installed service without touching owner files", () => {
    const helper = syncAgent.match(/retire_legacy_symphony\(\) \{\n[\s\S]*?\n\}/)?.[0];
    expect(helper).toBeDefined();
    const commands = execFileSync("bash", ["-c", `${helper}\nlog() { :; }\npersist_legacy_symphony_rollback() { :; }\nsudo() { case "$*" in *is-active*) return 1;; esac; printf '%s\\n' "$*"; }\nretire_legacy_symphony`], {
      encoding: "utf8",
    });
    expect(commands).toContain("systemctl disable --now matrix-symphony.service");
    expect(commands).not.toContain("/home/matrix/home");
    expect(syncAgent).toContain("retire_legacy_symphony");
    expect(syncAgent).not.toContain("write_symphony_env\n");
  });

  it("stops a still-active process if its unit file was already removed", () => {
    const helper = syncAgent.match(/retire_legacy_symphony\(\) \{\n[\s\S]*?\n\}/)?.[0];
    const commands = execFileSync("bash", ["-c", `${helper}\nlog() { :; }\nchecked=false\nsudo() { case "$*" in *cat*) return 1;; *is-active*) if [ "$checked" = false ]; then checked=true; return 0; fi; return 1;; esac; printf '%s\\n' "$*"; }\nretire_legacy_symphony`], { encoding: "utf8" });
    expect(commands).toContain("systemctl stop matrix-symphony.service");
  });

  it("does not ship the old service, binary, or Elixir release", () => {
    expect(existsSync("distro/customer-vps/systemd/matrix-symphony.service")).toBe(false);
    expect(existsSync("distro/customer-vps/host-bin/matrix-symphony")).toBe(false);
    expect(bundle).not.toContain("MIX_ENV=prod mix release symphony");
    expect(bundle).not.toContain("symphony-release");
    expect(bundle).not.toContain('"$STAGE_DIR/bin/matrix-symphony"');
  });

  it("retries retirement after an interrupted or partially successful update", () => {
    expect(syncAgent).toContain('maybe_retire_legacy_symphony()');
    expect(syncAgent).toContain('[ -x "$APP_DIR/packages/symphony-elixir/release/bin/symphony" ] && return 0');
    expect(syncAgent).toContain('maybe_retire_legacy_symphony || log "WARN: legacy Symphony retirement will retry"');
  });

  it("snapshots the old unit and retains it through a committed update for rollback", () => {
    expect(syncAgent).toContain('record_legacy_symphony_unit "$extract_dir"');
    expect(syncAgent).toContain('matrix-symphony.service:active');
    expect(syncAgent).toContain('preserve_symphony_rollback_transaction');
    expect(recovery).toContain('preserve_symphony_rollback_transaction');
    expect(syncAgent).toContain('if ! retire_legacy_symphony; then');
    expect(syncAgent).toContain('if resume_symphony_after_update; then\n      cleanup_update_transaction');
  });

  it("keeps the legacy unit backup across later update transactions", () => {
    expect(syncAgent).toContain('RETIRED_SYMPHONY_ROLLBACK_DIR="/etc/matrix-symphony-rollback"');
    expect(syncAgent).toContain('persist_legacy_symphony_rollback || return 1');
    expect(recovery).toContain('restore_retired_symphony_after_rollback');
    expect(recovery).toContain('[ -x "$APP_DIR/packages/symphony-elixir/release/bin/symphony" ] || return 0');
  });

  it("restores the original active unit after its update transaction is gone", () => {
    const base = mkdtempSync(join(tmpdir(), "symphony-retirement-"));
    try {
      const transaction = join(base, "transaction");
      const backup = join(base, "backup");
      const app = join(base, "app");
      const restored = join(base, "restored.service");
      const systemctlLog = join(base, "systemctl.log");
      mkdirSync(join(transaction, "systemd"), { recursive: true });
      mkdirSync(join(app, "packages/symphony-elixir/release/bin"), { recursive: true });
      writeFileSync(join(app, "packages/symphony-elixir/release/bin/symphony"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(transaction, "systemd/matrix-symphony.service"), "[Service]\nExecStart=/opt/matrix/bin/matrix-symphony\n");
      writeFileSync(join(transaction, "systemd.enablement"), "matrix-symphony.service:enabled\n");
      writeFileSync(join(transaction, "systemd.activity"), "matrix-symphony.service:active\n");
      const persist = syncAgent.match(/persist_legacy_symphony_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0];
      const restore = recovery.match(/restore_retired_symphony_after_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0]
        ?.replace("/etc/systemd/system/matrix-symphony.service", '"$RESTORED_UNIT_PATH"');
      expect(persist).toBeDefined();
      expect(restore).toBeDefined();
      execFileSync("bash", ["-c", `${persist}\n${restore}\nUPDATE_TRANSACTION_DIR="$1"\nRETIRED_SYMPHONY_ROLLBACK_DIR="$2"\nAPP_DIR="$3"\nRESTORED_UNIT_PATH="$4"\nSYSTEMCTL_LOG="$5"\nlog() { :; }\nrestore_regular_file_atomic() { cp "$1" "$RESTORED_UNIT_PATH"; }\nsudo() { if [ "$1" = install ]; then shift; local args=(); while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; install "${'${args[@]}'}"; elif [ "$1" = systemctl ]; then shift; printf 'systemctl %s\\n' "$*" >>"$SYSTEMCTL_LOG"; else "$@"; fi; }\npersist_legacy_symphony_rollback\nrm -rf -- "$UPDATE_TRANSACTION_DIR"\nrestore_retired_symphony_after_rollback`, "test", transaction, backup, app, restored, systemctlLog], { encoding: "utf8" });
      expect(readFileSync(restored, "utf8")).toContain("ExecStart=/opt/matrix/bin/matrix-symphony");
      expect(readFileSync(systemctlLog, "utf8")).toContain("systemctl enable matrix-symphony.service");
      expect(readFileSync(systemctlLog, "utf8")).toContain("systemctl start matrix-symphony.service");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("retires a masked legacy unit and restores the mask on rollback", () => {
    const base = mkdtempSync(join(tmpdir(), "symphony-masked-"));
    try {
      const transaction = join(base, "transaction");
      const backup = join(base, "backup");
      const app = join(base, "app");
      const maskedUnit = join(base, "matrix-symphony.service");
      const extract = join(base, "extract");
      mkdirSync(join(transaction, "systemd"), { recursive: true });
      mkdirSync(join(app, "packages/symphony-elixir/release/bin"), { recursive: true });
      mkdirSync(join(extract, "systemd"), { recursive: true });
      writeFileSync(join(app, "packages/symphony-elixir/release/bin/symphony"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(transaction, "systemd.enablement"), "");
      writeFileSync(join(transaction, "systemd.activity"), "");
      symlinkSync("/dev/null", maskedUnit);
      const getHelper = (name: string) => syncAgent.match(new RegExp(`${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}`))?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$MASKED_UNIT_PATH"')
        .replace('"/etc/systemd/system/$name"', '"$MASKED_UNIT_PATH"');
      const record = getHelper("record_legacy_symphony_unit");
      const persist = getHelper("persist_legacy_symphony_rollback");
      const retire = getHelper("retire_legacy_symphony");
      const restore = recovery.match(/restore_retired_symphony_after_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$MASKED_UNIT_PATH"');
      expect(record && persist && retire && restore).toBeTruthy();
      execFileSync("bash", ["-c", `set -e\n${record}\n${persist}\n${retire}\n${restore}\nUPDATE_TRANSACTION_DIR="$1"\nRETIRED_SYMPHONY_ROLLBACK_DIR="$2"\nAPP_DIR="$3"\nMASKED_UNIT_PATH="$4"\nlog() { :; }\nrestore_regular_file_atomic() { return 1; }\nsudo() {\n  if [ "$1" = systemctl ]; then\n    case "$2" in\n      is-enabled) printf 'masked\\n';;\n      is-active) if [ "$3" = --quiet ]; then return 1; fi; printf 'inactive\\n';;\n      cat|daemon-reload|stop) return 0;;\n      mask) ln -s /dev/null "$MASKED_UNIT_PATH";;\n      *) return 1;;\n    esac\n  elif [ "$1" = install ]; then\n    shift\n    local args=()\n    while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done\n    install "${'${args[@]}'}"\n  else\n    "$@"\n  fi\n}\nrecord_legacy_symphony_unit "$5"\nretire_legacy_symphony\n[ ! -e "$MASKED_UNIT_PATH" ] && [ ! -L "$MASKED_UNIT_PATH" ]\nrm -rf -- "$UPDATE_TRANSACTION_DIR"\nrestore_retired_symphony_after_rollback`, "test", transaction, backup, app, maskedUnit, extract], { encoding: "utf8" });
      expect(readlinkSync(maskedUnit)).toBe("/dev/null");
      expect(existsSync(join(backup, "masked"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
