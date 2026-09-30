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

  it("does not ship the retired first-party app", () => {
    expect(existsSync("home/apps/symphony")).toBe(false);
    const manifest = JSON.parse(readFileSync("home/.template-manifest.json", "utf8")) as Record<string, string>;
    expect(Object.keys(manifest).some((path) => path.startsWith("apps/symphony/"))).toBe(false);
  });

  it("removes the retired Elixir source package", () => {
    expect(existsSync("packages/symphony-elixir")).toBe(false);
  });

  it("retries retirement after an interrupted or partially successful update", () => {
    expect(syncAgent).toContain('maybe_retire_legacy_symphony()');
    expect(syncAgent).toContain('[ -x "$APP_DIR/packages/symphony-elixir/release/bin/symphony" ] && return 0');
    expect(syncAgent).toContain('maybe_retire_legacy_symphony || log "WARN: legacy Symphony retirement will retry"');
  });

  it("snapshots the old unit and retains it through a committed update for rollback", () => {
    expect(syncAgent).toContain('record_legacy_symphony_unit "$extract_dir"');
    expect(syncAgent).toContain('matrix-symphony.service:active');
    expect(syncAgent).toContain('preserve_host_rollback_transaction');
    expect(recovery).toContain('preserve_host_rollback_transaction');
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

  it("retires a live legacy unit after an older updater cleared its transaction", () => {
    const base = mkdtempSync(join(tmpdir(), "symphony-first-upgrade-"));
    try {
      const liveUnit = join(base, "matrix-symphony.service");
      const backup = join(base, "backup");
      writeFileSync(liveUnit, "[Service]\nExecStart=/opt/matrix/bin/matrix-symphony\n");
      const helper = (name: string) => syncAgent.match(new RegExp(`${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}`))?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$LIVE_UNIT_PATH"');
      const persist = helper("persist_legacy_symphony_rollback");
      const retire = helper("retire_legacy_symphony");
      expect(persist && retire).toBeTruthy();
      execFileSync("bash", ["-c", `set -e
${persist}
${retire}
UPDATE_TRANSACTION_DIR="$1"
RETIRED_SYMPHONY_ROLLBACK_DIR="$2"
LIVE_UNIT_PATH="$3"
active=true
log() { :; }
sudo() {
  if [ "$1" = systemctl ]; then
    case "$2" in
      cat|daemon-reload) return 0;;
      is-enabled) printf 'enabled\\n';;
      is-active) if [ "$3" = --quiet ]; then [ "$active" = true ]; else printf '%s\\n' "$([ "$active" = true ] && echo active || echo inactive)"; fi;;
      disable) active=false;;
      *) return 1;;
    esac
  elif [ "$1" = tee ]; then
    shift
    tee "$@"
  elif [ "$1" = install ]; then
    shift
    local args=()
    while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
    install "${'${args[@]}'}"
  else
    "$@"
  fi
}
retire_legacy_symphony`, "test", join(base, "cleared-transaction"), backup, liveUnit], { encoding: "utf8" });
      expect(existsSync(liveUnit)).toBe(false);
      expect(readFileSync(join(backup, "unit"), "utf8")).toContain("ExecStart=/opt/matrix/bin/matrix-symphony");
      expect(readFileSync(join(backup, "enablement"), "utf8")).toBe("matrix-symphony.service:enabled\n");
      expect(readFileSync(join(backup, "activity"), "utf8")).toBe("matrix-symphony.service:active\n");
      const app = join(base, "app");
      const systemctlLog = join(base, "systemctl.log");
      mkdirSync(join(app, "packages/symphony-elixir/release/bin"), { recursive: true });
      writeFileSync(join(app, "packages/symphony-elixir/release/bin/symphony"), "#!/bin/sh\n", { mode: 0o755 });
      const restore = recovery.match(/restore_retired_symphony_after_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$LIVE_UNIT_PATH"');
      expect(restore).toBeDefined();
      execFileSync("bash", ["-c", `set -e\n${restore}\nAPP_DIR="$1"\nRETIRED_SYMPHONY_ROLLBACK_DIR="$2"\nLIVE_UNIT_PATH="$3"\nSYSTEMCTL_LOG="$4"\nrestore_regular_file_atomic() { cp "$1" "$LIVE_UNIT_PATH"; }\nsudo() { if [ "$1" = systemctl ]; then shift; printf 'systemctl %s\\n' "$*" >>"$SYSTEMCTL_LOG"; else "$@"; fi; }\nrestore_retired_symphony_after_rollback`, "test", app, backup, liveUnit, systemctlLog]);
      expect(readFileSync(liveUnit, "utf8")).toContain("ExecStart=/opt/matrix/bin/matrix-symphony");
      expect(readFileSync(systemctlLog, "utf8")).toContain("systemctl enable matrix-symphony.service");
      expect(readFileSync(systemctlLog, "utf8")).toContain("systemctl start matrix-symphony.service");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("retires a masked unit after an older updater cleared its transaction", () => {
    const base = mkdtempSync(join(tmpdir(), "symphony-masked-first-upgrade-"));
    try {
      const liveUnit = join(base, "matrix-symphony.service");
      const backup = join(base, "backup");
      symlinkSync("/dev/null", liveUnit);
      const helper = (name: string) => syncAgent.match(new RegExp(`${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}`))?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$LIVE_UNIT_PATH"');
      const persist = helper("persist_legacy_symphony_rollback");
      const retire = helper("retire_legacy_symphony");
      expect(persist && retire).toBeTruthy();
      execFileSync("bash", ["-c", `set -e
${persist}
${retire}
UPDATE_TRANSACTION_DIR="$1"
RETIRED_SYMPHONY_ROLLBACK_DIR="$2"
LIVE_UNIT_PATH="$3"
log() { :; }
sudo() {
  if [ "$1" = systemctl ]; then
    case "$2" in
      is-enabled) printf 'masked\\n';;
      is-active) if [ "$3" = --quiet ]; then return 1; fi; printf 'inactive\\n';;
      daemon-reload) return 0;;
      *) return 1;;
    esac
  elif [ "$1" = install ]; then
    shift
    local args=()
    while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
    install "${'${args[@]}'}"
  elif [ "$1" = tee ]; then
    shift
    tee "$@"
  else
    "$@"
  fi
}
retire_legacy_symphony`, "test", join(base, "cleared-transaction"), backup, liveUnit], { encoding: "utf8" });
      expect(existsSync(liveUnit)).toBe(false);
      expect(existsSync(join(backup, "masked"))).toBe(true);
      expect(readFileSync(join(backup, "enablement"), "utf8")).toBe("matrix-symphony.service:masked\n");
      const app = join(base, "app");
      const systemctlLog = join(base, "systemctl.log");
      mkdirSync(join(app, "packages/symphony-elixir/release/bin"), { recursive: true });
      writeFileSync(join(app, "packages/symphony-elixir/release/bin/symphony"), "#!/bin/sh\n", { mode: 0o755 });
      const restore = recovery.match(/restore_retired_symphony_after_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$LIVE_UNIT_PATH"');
      expect(restore).toBeDefined();
      execFileSync("bash", ["-c", `set -e\n${restore}\nAPP_DIR="$1"\nRETIRED_SYMPHONY_ROLLBACK_DIR="$2"\nLIVE_UNIT_PATH="$3"\nSYSTEMCTL_LOG="$4"\nrestore_regular_file_atomic() { return 1; }\nsudo() { if [ "$1" = systemctl ]; then shift; printf 'systemctl %s\\n' "$*" >>"$SYSTEMCTL_LOG"; case "$1" in mask) ln -s /dev/null "$LIVE_UNIT_PATH";; esac; else "$@"; fi; }\nrestore_retired_symphony_after_rollback`, "test", app, backup, liveUnit, systemctlLog]);
      expect(readlinkSync(liveUnit)).toBe("/dev/null");
      expect(readFileSync(systemctlLog, "utf8")).toContain("systemctl mask matrix-symphony.service");
      expect(readFileSync(systemctlLog, "utf8")).toContain("systemctl stop matrix-symphony.service");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps the original rollback state when retirement retries after disabling the unit", () => {
    const base = mkdtempSync(join(tmpdir(), "symphony-retirement-retry-"));
    try {
      const liveUnit = join(base, "matrix-symphony.service");
      const backup = join(base, "backup");
      mkdirSync(backup);
      writeFileSync(liveUnit, "[Service]\nExecStart=/opt/matrix/bin/matrix-symphony\n");
      writeFileSync(join(backup, "unit"), readFileSync(liveUnit));
      writeFileSync(join(backup, "enablement"), "matrix-symphony.service:enabled\n");
      writeFileSync(join(backup, "activity"), "matrix-symphony.service:active\n");
      const persist = syncAgent.match(/persist_legacy_symphony_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$LIVE_UNIT_PATH"');
      expect(persist).toBeDefined();
      execFileSync("bash", ["-c", `set -e
${persist}
UPDATE_TRANSACTION_DIR="$1"
RETIRED_SYMPHONY_ROLLBACK_DIR="$2"
LIVE_UNIT_PATH="$3"
log() { :; }
sudo() {
  if [ "$1" = systemctl ]; then
    case "$2" in
      is-enabled) printf 'disabled\\n';;
      is-active) printf 'inactive\\n';;
      *) return 1;;
    esac
  elif [ "$1" = install ]; then
    shift
    local args=()
    while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
    install "${'${args[@]}'}"
  elif [ "$1" = tee ]; then
    shift
    tee "$@"
  else
    "$@"
  fi
}
persist_legacy_symphony_rollback`, "test", join(base, "cleared-transaction"), backup, liveUnit], { encoding: "utf8" });
      expect(readFileSync(join(backup, "enablement"), "utf8")).toBe("matrix-symphony.service:enabled\n");
      expect(readFileSync(join(backup, "activity"), "utf8")).toBe("matrix-symphony.service:active\n");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not replace an incomplete prior rollback snapshot with stopped service state", () => {
    const base = mkdtempSync(join(tmpdir(), "symphony-invalid-backup-"));
    try {
      const liveUnit = join(base, "matrix-symphony.service");
      const backup = join(base, "backup");
      mkdirSync(backup);
      writeFileSync(liveUnit, "[Service]\nExecStart=/opt/matrix/bin/matrix-symphony\n");
      writeFileSync(join(backup, "unit"), readFileSync(liveUnit));
      writeFileSync(join(backup, "enablement"), "matrix-symphony.service:enabled\n");
      const persist = syncAgent.match(/persist_legacy_symphony_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0]
        .replaceAll("/etc/systemd/system/matrix-symphony.service", '"$LIVE_UNIT_PATH"');
      expect(persist).toBeDefined();
      const command = `set -e
${persist}
UPDATE_TRANSACTION_DIR="$1"
RETIRED_SYMPHONY_ROLLBACK_DIR="$2"
LIVE_UNIT_PATH="$3"
log() { :; }
sudo() {
  if [ "$1" = systemctl ]; then
    case "$2" in is-enabled) printf 'disabled\\n';; is-active) printf 'inactive\\n';; esac
  elif [ "$1" = install ]; then
    shift
    local args=()
    while [ "$#" -gt 0 ]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done
    install "${'${args[@]}'}"
  elif [ "$1" = tee ]; then shift; tee "$@"
  else "$@"; fi
}
persist_legacy_symphony_rollback`;
      expect(() => execFileSync("bash", ["-c", command, "test", join(base, "cleared-transaction"), backup, liveUnit])).toThrow();
      expect(readFileSync(join(backup, "enablement"), "utf8")).toBe("matrix-symphony.service:enabled\n");
      expect(existsSync(join(backup, "activity"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("clears the durable snapshot only after a healthy rollback restores the old runtime", () => {
    const base = mkdtempSync(join(tmpdir(), "symphony-rollback-cleanup-"));
    try {
      const app = join(base, "app");
      const backup = join(base, "backup");
      const oldBinary = join(app, "packages/symphony-elixir/release/bin/symphony");
      mkdirSync(join(app, "packages/symphony-elixir/release/bin"), { recursive: true });
      mkdirSync(backup);
      writeFileSync(oldBinary, "#!/bin/sh\n", { mode: 0o755 });
      const clear = recovery.match(/clear_retired_symphony_rollback_after_rollback\(\) \{\n[\s\S]*?\n\}/)?.[0];
      expect(clear).toBeDefined();
      expect(recovery).toContain("clear_retired_symphony_rollback_after_rollback || return 1");
      const command = `set -e\n${clear}\nAPP_DIR="$1"\nRETIRED_SYMPHONY_ROLLBACK_DIR="$2"\nsudo() { "$@"; }\nclear_retired_symphony_rollback_after_rollback`;
      execFileSync("bash", ["-c", command, "test", app, backup]);
      expect(existsSync(backup)).toBe(false);
      mkdirSync(backup);
      rmSync(oldBinary);
      execFileSync("bash", ["-c", command, "test", app, backup]);
      expect(existsSync(backup)).toBe(true);
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
