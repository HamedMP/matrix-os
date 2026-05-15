import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalHermesBridge } from "../../packages/gateway/src/hermes/bridge.js";
import { defaultHermesInstallation } from "../../packages/gateway/src/hermes/contracts.js";

describe("Hermes bridge", () => {
  it("reports missing Hermes without exposing raw paths", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    const bridge = createLocalHermesBridge({ homePath, hermesPath: join(homePath, "missing-hermes") });

    const status = await bridge.getStatus({ ownerId: "user_123", installation: null });

    expect(status).toMatchObject({ readiness: "missing", hermesPathLabel: "missing-hermes" });
    expect(status.gatewayStatus).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(homePath);
  });

  it("returns redacted channel action results for Telegram and WhatsApp", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    const bridge = createLocalHermesBridge({ homePath, hermesPath: join(homePath, "missing-hermes") });

    await expect(bridge.runChannelAction({ ownerId: "user_123", installation: null, channelId: "telegram", action: { type: "connect", payload: {} } }))
      .resolves.toMatchObject({ channel: { id: "telegram", status: "connected", enabled: true } });
    await expect(bridge.runChannelAction({ ownerId: "user_123", installation: null, channelId: "whatsapp", action: { type: "start_pairing", payload: {} } }))
      .resolves.toMatchObject({ channel: { id: "whatsapp", status: "pairing", configured: true }, pairing: { kind: "code", displayValue: "PAIR-HERMES" } });
  });

  it("uses the validated custom Hermes path for follow-up CLI status checks", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    const customHermesPath = join(homePath, "system", "hermes", "custom");
    await mkdir(customHermesPath, { recursive: true });
    await writeFile(join(customHermesPath, "cli.py"), "print('custom-hermes 1.2.3')\n");
    const bridge = createLocalHermesBridge({ homePath, hermesPath: join(homePath, "missing-hermes") });

    const saved = await bridge.saveConfig({
      ownerId: "user_123",
      installation: null,
      config: {
        homeMode: "custom",
        hermesPath: customHermesPath,
        defaultProfileId: "default",
        authorizedOperators: [],
      },
    });
    const beforeActivation = await bridge.getStatus({ ownerId: "user_123", installation: null });
    saved.activate();
    const status = await bridge.getStatus({ ownerId: "user_123", installation: null });

    expect(saved.patch).toMatchObject({ hermesPathLabel: "custom" });
    expect(saved.patch.readiness).toBeUndefined();
    expect(beforeActivation).toMatchObject({ readiness: "missing", hermesPathLabel: "missing-hermes" });
    expect(beforeActivation.gatewayStatus).toBeUndefined();
    expect(status).toMatchObject({ readiness: "installed", hermesPathLabel: "custom", version: "custom-hermes 1.2.3" });
    expect(status.gatewayStatus).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(homePath);
  });

  it("does not emit installed readiness when an existing installation is already ready", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    await writeFile(join(homePath, "cli.py"), "print('ready-hermes 1.0.0')\n");
    const bridge = createLocalHermesBridge({ homePath, hermesPath: homePath });
    const installation = { ...defaultHermesInstallation("user_123"), readiness: "ready" as const };

    const status = await bridge.getStatus({ ownerId: "user_123", installation });

    expect(status.readiness).toBeUndefined();
    expect(status.version).toBe("ready-hermes 1.0.0");
  });

  it("keeps custom Hermes paths scoped per owner", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    const ownerAPath = join(homePath, "system", "hermes", "owner-a");
    const ownerBPath = join(homePath, "system", "hermes", "owner-b");
    await mkdir(ownerAPath, { recursive: true });
    await mkdir(ownerBPath, { recursive: true });
    await writeFile(join(ownerAPath, "cli.py"), "print('owner-a 1.0.0')\n");
    await writeFile(join(ownerBPath, "cli.py"), "print('owner-b 1.0.0')\n");
    const bridge = createLocalHermesBridge({ homePath, hermesPath: join(homePath, "missing-hermes") });

    const ownerA = await bridge.saveConfig({
      ownerId: "user_a",
      installation: null,
      config: { homeMode: "custom", hermesPath: ownerAPath, defaultProfileId: "default", authorizedOperators: [] },
    });
    ownerA.activate();
    const ownerB = await bridge.saveConfig({
      ownerId: "user_b",
      installation: null,
      config: { homeMode: "custom", hermesPath: ownerBPath, defaultProfileId: "default", authorizedOperators: [] },
    });
    ownerB.activate();

    await expect(bridge.getStatus({ ownerId: "user_a", installation: null }))
      .resolves.toMatchObject({ hermesPathLabel: "owner-a", version: "owner-a 1.0.0" });
    await expect(bridge.getStatus({ ownerId: "user_b", installation: null }))
      .resolves.toMatchObject({ hermesPathLabel: "owner-b", version: "owner-b 1.0.0" });
  });

  it("restores owner-home custom Hermes paths from persisted installation labels after restart", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    const customHermesPath = join(homePath, "system", "hermes", "custom");
    await mkdir(customHermesPath, { recursive: true });
    await writeFile(join(customHermesPath, "cli.py"), "print('restored 1.0.0')\n");
    const first = createLocalHermesBridge({ homePath, hermesPath: join(homePath, "missing-hermes") });
    const saved = await first.saveConfig({
      ownerId: "user_123",
      installation: null,
      config: { homeMode: "custom", hermesPath: customHermesPath, defaultProfileId: "default", authorizedOperators: [] },
    });
    const restarted = createLocalHermesBridge({ homePath, hermesPath: join(homePath, "missing-hermes") });
    const installation = {
      ...defaultHermesInstallation("user_123"),
      homeMode: "custom" as const,
      hermesPathLabel: saved.patch.hermesPathLabel ?? null,
    };

    await expect(restarted.getStatus({ ownerId: "user_123", installation }))
      .resolves.toMatchObject({ readiness: "installed", hermesPathLabel: "custom", version: "restored 1.0.0" });
  });

  it("restores owner-home custom paths even when their label matches the default path", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    const defaultHermesPath = join(homePath, "default-root", "custom");
    const customHermesPath = join(homePath, "system", "hermes", "custom");
    await mkdir(defaultHermesPath, { recursive: true });
    await mkdir(customHermesPath, { recursive: true });
    await writeFile(join(defaultHermesPath, "cli.py"), "print('default 1.0.0')\n");
    await writeFile(join(customHermesPath, "cli.py"), "print('owner 1.0.0')\n");
    const restarted = createLocalHermesBridge({ homePath, hermesPath: defaultHermesPath });
    const installation = {
      ...defaultHermesInstallation("user_123"),
      homeMode: "custom" as const,
      hermesPathLabel: "custom",
    };

    await expect(restarted.getStatus({ ownerId: "user_123", installation }))
      .resolves.toMatchObject({ readiness: "installed", hermesPathLabel: "custom", version: "owner 1.0.0" });
  });

  it("normalizes the configured default Hermes root to default mode", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-hermes-bridge-"));
    const externalHermesPath = await mkdtemp(join(tmpdir(), "matrix-hermes-external-"));
    await writeFile(join(externalHermesPath, "cli.py"), "print('external 1.0.0')\n");
    const first = createLocalHermesBridge({ homePath, hermesPath: externalHermesPath });
    const saved = await first.saveConfig({
      ownerId: "user_123",
      installation: null,
      config: { homeMode: "custom", hermesPath: externalHermesPath, defaultProfileId: "default", authorizedOperators: [] },
    });
    const restarted = createLocalHermesBridge({ homePath, hermesPath: externalHermesPath });
    const installation = { ...defaultHermesInstallation("user_123"), ...saved.patch };

    const status = await restarted.getStatus({ ownerId: "user_123", installation });

    expect(saved.patch).toMatchObject({ homeMode: "default", hermesPathLabel: null });
    expect(status).toMatchObject({ readiness: "installed", version: "external 1.0.0" });
    expect(status.hermesPathLabel).toContain("matrix-hermes-external-");
  });
});
