import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { configureOpenClawSharedBrowser } from "../../../distro/customer-vps/host-bin/matrix-configure-openclaw-shared-browser.mjs";
import { OPENCLAW_SHARED_BROWSER_MANIFEST } from "../../../packages/gateway/src/chat/openclaw-shared-browser-plugin-entry.js";
const ID = "matrix-shared-browser";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-openclaw-browser-install-")); const stateDir = join(root, ".openclaw"); await mkdir(stateDir);
  const configPath = join(stateDir, "openclaw.json"); const initial = { gateway: { mode: "local", bind: "loopback", port: 18789, auth: { mode: "token" } },
    plugins: { allow: [], entries: { "owner-other": { enabled: false, config: { retain: "owner" } } } },
    models: { ownerSetting: "keep" }, tools: { deny: ["gateway", "cron", "sessions_spawn", "sessions_send"] } };
  await writeFile(configPath, JSON.stringify(initial));
  const options = { stateDir, configPath, gatewayPort: 4000, enabled: true, compiledEntry: "/opt/matrix/app/packages/gateway/dist/chat/openclaw-shared-browser-plugin-entry.js", manifest: OPENCLAW_SHARED_BROWSER_MANIFEST };
  return { root, stateDir, configPath, initial, options, async close() { await rm(root, { recursive: true, force: true }); } };
}
it("installs only the fixed contained Matrix plugin, preserving owner model/configuration fields", async () => {
  const f = await fixture(); try {
    expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "installed" });
    const config = JSON.parse(await readFile(f.configPath, "utf8")); expect(config.models).toEqual(f.initial.models); expect(config.tools).toEqual(f.initial.tools);
    expect(config.plugins.entries["owner-other"]).toEqual(f.initial.plugins.entries["owner-other"]);
    expect(config.plugins.allow).toEqual([ID]); expect(config.plugins.entries[ID]).toEqual({ enabled: true, config: { gatewayPort: 4000 } });
    expect(config.plugins).not.toHaveProperty("installs");
    const dir = join(f.stateDir, "extensions", ID); const pkg = JSON.parse(await readFile(join(dir,"package.json"),"utf8"));
    expect(pkg.openclaw.extensions).toEqual(["./index.mjs"]);
    expect(await readFile(join(dir, "index.mjs"), "utf8")).toBe('import { resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";\nimport { createOpenClawSharedBrowserPlugin } from "/opt/matrix/app/packages/gateway/dist/chat/openclaw-shared-browser-plugin-entry.js";\nexport default createOpenClawSharedBrowserPlugin(resolveGatewayAuth);\n');
    expect(JSON.parse(await readFile(join(dir, "openclaw.plugin.json"), "utf8"))).toEqual(OPENCLAW_SHARED_BROWSER_MANIFEST);
    const bytes = await readFile(f.configPath); await configureOpenClawSharedBrowser(f.options); expect(await readFile(f.configPath)).toEqual(bytes);
  } finally { await f.close(); }
});
it("removes only a proven legacy Matrix receipt without changing plugin files or owner settings", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options);
    const pluginPath = join(f.stateDir, "extensions", ID);
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    config.plugins.installs = { [ID]: { source: "path", sourcePath: pluginPath, installPath: pluginPath,
      version: OPENCLAW_SHARED_BROWSER_MANIFEST.version, installedAt: "2026-01-01T00:00:00.000Z" } };
    await writeFile(f.configPath, JSON.stringify(config));
    const files = await Promise.all(["index.mjs", "package.json", "openclaw.plugin.json"].map(name => readFile(join(pluginPath, name))));
    expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "installed" });
    delete config.plugins.installs;
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(config);
    expect(await Promise.all(["index.mjs", "package.json", "openclaw.plugin.json"].map(name => readFile(join(pluginPath, name))))).toEqual(files);
  } finally { await f.close(); }
});
it("migrates a proven legacy receipt without changing disabled activation", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options);
    const pluginPath = join(f.stateDir, "extensions", ID);
    const receipt = { source: "path", sourcePath: pluginPath, installPath: pluginPath,
      version: OPENCLAW_SHARED_BROWSER_MANIFEST.version, installedAt: "2026-01-01T00:00:00.000Z" };

    const featureDisabled = JSON.parse(await readFile(f.configPath, "utf8"));
    featureDisabled.plugins.installs = { [ID]: receipt };
    await writeFile(f.configPath, JSON.stringify(featureDisabled));
    expect(await configureOpenClawSharedBrowser({ ...f.options, enabled: false })).toMatchObject({ state: "feature_disabled" });
    const featureConfig = JSON.parse(await readFile(f.configPath, "utf8"));
    expect(featureConfig.plugins).not.toHaveProperty("installs");
    expect(featureConfig.plugins.allow).toEqual([]);

    const ownerDisabled = { ...featureConfig, plugins: { ...featureConfig.plugins, allow: [ID], installs: { [ID]: receipt },
      entries: { ...featureConfig.plugins.entries, [ID]: { enabled: false, config: { gatewayPort: 4000 } } } } };
    await writeFile(f.configPath, JSON.stringify(ownerDisabled));
    expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "owner_disabled" });
    const ownerConfig = JSON.parse(await readFile(f.configPath, "utf8"));
    expect(ownerConfig.plugins).not.toHaveProperty("installs");
    expect(ownerConfig.plugins.entries[ID]).toEqual(ownerDisabled.plugins.entries[ID]);
    expect(ownerConfig.plugins.allow).toEqual([ID]);
  } finally { await f.close(); }
});
it("refuses foreign or unproven legacy receipts without modifying configuration", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options);
    const pluginPath = join(f.stateDir, "extensions", ID);
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    const receipt = { source: "path", sourcePath: pluginPath, installPath: pluginPath,
      version: OPENCLAW_SHARED_BROWSER_MANIFEST.version, installedAt: "2026-01-01T00:00:00.000Z" };
    for (const installs of [{ owner: receipt }, { [ID]: receipt, owner: receipt }, {}, { [ID]: { ...receipt, installedAt: "invalid" } },
      { [ID]: { ...receipt, version: "foreign" } }, { [ID]: { ...receipt, sourcePath: "/owner/custom" } }]) {
      await writeFile(f.configPath, JSON.stringify({ ...config, plugins: { ...config.plugins, installs } }));
      const before = await readFile(f.configPath);
      await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
      expect(await readFile(f.configPath)).toEqual(before);
    }
    await writeFile(f.configPath, JSON.stringify({ ...config, plugins: { ...config.plugins, installs: { [ID]: receipt } } }));
    const before = await readFile(f.configPath);
    await rm(join(f.stateDir, ".matrix-shared-browser-installed.json"));
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
    expect(await readFile(f.configPath)).toEqual(before);
  } finally { await f.close(); }
});
it("requires the complete installed-file fingerprints before migrating a legacy Matrix receipt", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options);
    const pluginPath = join(f.stateDir, "extensions", ID), markerPath = join(f.stateDir, ".matrix-shared-browser-installed.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    config.plugins.installs = { [ID]: { source: "path", sourcePath: pluginPath, installPath: pluginPath,
      version: OPENCLAW_SHARED_BROWSER_MANIFEST.version, installedAt: "2026-01-01T00:00:00.000Z" } };
    await writeFile(f.configPath, JSON.stringify(config)); const before = await readFile(f.configPath);
    await writeFile(markerPath, JSON.stringify({ ...marker, files: { ...marker.files, "index.mjs": "0".repeat(64) } }));
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow(); expect(await readFile(f.configPath)).toEqual(before);
    await writeFile(markerPath, JSON.stringify(marker));
    await writeFile(join(pluginPath, "index.mjs"), "// owner customization");
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow(); expect(await readFile(f.configPath)).toEqual(before);
    expect(await readFile(join(pluginPath, "index.mjs"), "utf8")).toBe("// owner customization");
  } finally { await f.close(); }
});
it("does not silently re-enable owner-disabled or owner-uninstalled plugins", async () => {
  const f = await fixture(); try {
    await writeFile(f.configPath, JSON.stringify({ ...f.initial, plugins: { allow: [], entries: { [ID]: { enabled: false } } } }));
    const before = await readFile(f.configPath); expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "owner_disabled" }); expect(await readFile(f.configPath)).toEqual(before);
    await writeFile(f.configPath, JSON.stringify(f.initial)); await configureOpenClawSharedBrowser(f.options);
    const removed = { ...f.initial, plugins: { entries: f.initial.plugins.entries } };
    await writeFile(f.configPath, JSON.stringify(removed)); await rm(join(f.stateDir,"extensions",ID), { recursive: true });
    expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "owner_uninstalled" });
    expect(JSON.parse(await readFile(f.configPath,"utf8"))).toEqual(removed);
  } finally { await f.close(); }
});
it("disables only Matrix activation when the trusted optional feature is off and honors harness opt-out", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options); await configureOpenClawSharedBrowser({ ...f.options, enabled: false });
    expect(JSON.parse(await readFile(f.configPath,"utf8")).plugins.allow).toEqual([]);
    const before = await readFile(f.configPath); const marker = join(f.root,"disabled-openclaw"); await writeFile(marker,"owner opt-out");
    expect(await configureOpenClawSharedBrowser({ ...f.options, disabledMarker: marker })).toMatchObject({ state: "harness_disabled" });
    expect(await readFile(f.configPath)).toEqual(before);
  } finally { await f.close(); }
});
it("refuses native owner plugin allowlist overrides and symlink/custom-file replacement", async () => {
  const f = await fixture(); try {
    await writeFile(f.configPath, JSON.stringify({ ...f.initial, plugins: { allow: ["owner-extra"] } }));
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
    await writeFile(f.configPath, JSON.stringify(f.initial)); const outside = join(f.root,"outside"); await mkdir(outside);
    await symlink(outside, join(f.stateDir,"extensions")); await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
    await rm(join(f.stateDir,"extensions")); await mkdir(join(f.stateDir,"extensions",ID), { recursive:true });
    await writeFile(join(f.stateDir,"extensions",ID,"index.mjs"),"// owner customization");
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
    expect(await readFile(join(f.stateDir,"extensions",ID,"index.mjs"),"utf8")).toBe("// owner customization");
    expect(JSON.parse(await readFile(f.configPath,"utf8"))).toEqual(f.initial);
  } finally { await f.close(); }
});
it("does not follow a symlinked config or overwrite a concurrent owner edit", async () => {
  const f = await fixture(); try {
    const outside = join(f.root,"owner.json"); await writeFile(outside,JSON.stringify(f.initial)); await rm(f.configPath); await symlink(outside,f.configPath);
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow(); expect(JSON.parse(await readFile(outside,"utf8"))).toEqual(f.initial);
    await rm(f.configPath); await writeFile(f.configPath,JSON.stringify(f.initial));
    const changed = { ...f.initial, models: { ownerSetting:"newer" } };
    await expect(configureOpenClawSharedBrowser({ ...f.options, beforeConfigCommit: async () => writeFile(f.configPath,JSON.stringify(changed)) })).rejects.toThrow();
    expect(JSON.parse(await readFile(f.configPath,"utf8"))).toEqual(changed);
  } finally { await f.close(); }
});

it("respects native global/deny opt-outs and rejects source shadowing through extra plugin load paths", async () => {
  const f = await fixture(); try {
    await writeFile(f.configPath,JSON.stringify({ ...f.initial, plugins: { enabled:false,allow:[] } }));
    expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({state:"owner_disabled"});
    await writeFile(f.configPath,JSON.stringify({ ...f.initial, plugins: { allow:[],deny:[ID] } }));
    expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({state:"owner_disabled"});
    await writeFile(f.configPath,JSON.stringify({ ...f.initial, plugins: { allow:[],load:{paths:["/owner/other-plugin"]} } }));
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
  } finally { await f.close(); }
});
it("activates the real host wrapper only with the trusted optional flag and exact Matrix plugin allowlist", async () => {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const { chmod } = await import("node:fs/promises");
  const run = promisify(execFile); const f = await fixture(); try {
    const appDir=join(f.root,"app"),entryDir=join(appDir,"packages/gateway/dist/chat"),prefix=join(f.root,"node"),nodeDir=join(prefix,"bin");
    await mkdir(entryDir,{recursive:true});await mkdir(nodeDir,{recursive:true});await symlink(process.execPath,join(nodeDir,"node"));
    await writeFile(join(entryDir,"openclaw-shared-browser-plugin-entry.js"),`export const OPENCLAW_SHARED_BROWSER_MANIFEST=${JSON.stringify(OPENCLAW_SHARED_BROWSER_MANIFEST)};`);
    const native=join(nodeDir,"openclaw"),started=join(f.root,"started");await writeFile(native,`#!/usr/bin/env bash
set -euo pipefail
"$MATRIX_NODE_PREFIX/bin/node" - "$OPENCLAW_CONFIG_PATH" <<'NODE'
const config = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const matrixEnvPresent = Object.entries(process.env).some(([key, value]) => key.startsWith('MATRIX_') && value);
if (matrixEnvPresent && config.channels?.matrix?.enabled !== false) process.exit(1);
NODE
printf 'started' > '${started}'
`);await chmod(native,0o755);
    const auth=join(f.root,"auth.env");await writeFile(auth,`OPENCLAW_GATEWAY_TOKEN=${"a".repeat(64)}\n`);
    const env={...process.env,MATRIX_RUNTIME_HOME:f.root,MATRIX_NODE_PREFIX:prefix,OPENCLAW_STATE_DIR:f.stateDir,OPENCLAW_CONFIG_PATH:f.configPath,OPENCLAW_ENV_FILE:auth,OPENCLAW_BIN:native,
      MATRIX_OPENCLAW_BROWSER_CONFIGURER:resolve("distro/customer-vps/host-bin/matrix-configure-openclaw-shared-browser.mjs"),MATRIX_APP_DIR:appDir,MATRIX_BROWSER_LAB:"true",PORT:"4123",TMPDIR:f.root};
    await expect(run("bash",["distro/customer-vps/host-bin/matrix-openclaw-gateway"],{env})).resolves.toBeDefined();
    expect(await readFile(started,"utf8")).toBe("started");expect(JSON.parse(await readFile(f.configPath,"utf8")).plugins.entries[ID].config.gatewayPort).toBe(4123);
    const disabled=JSON.parse(await readFile(f.configPath,"utf8")),pluginPath=join(f.stateDir,"extensions",ID);
    disabled.plugins.installs={ [ID]: { source:"path",sourcePath:pluginPath,installPath:pluginPath,
      version:OPENCLAW_SHARED_BROWSER_MANIFEST.version,installedAt:"2026-01-01T00:00:00.000Z" } };
    await writeFile(f.configPath,JSON.stringify(disabled));
    await expect(run("bash",["distro/customer-vps/host-bin/matrix-openclaw-gateway"],{env:{...env,MATRIX_BROWSER_LAB:"false"}})).resolves.toBeDefined();
    const migrated=JSON.parse(await readFile(f.configPath,"utf8"));expect(migrated.plugins.allow).toEqual([]);expect(migrated.plugins).not.toHaveProperty("installs");
    await rm(started);await writeFile(f.configPath,JSON.stringify({...f.initial,plugins:{allow:["owner-extra"]}}));
    await expect(run("bash",["distro/customer-vps/host-bin/matrix-openclaw-gateway"],{env})).rejects.toMatchObject({code:3});
    await expect(readFile(started)).rejects.toMatchObject({code:"ENOENT"});
  } finally {await f.close();}
});
it("invokes optional installer configuration only at stopped-service install or coordinated gateway startup", async () => {
  const installer=await readFile("distro/customer-vps/host-bin/matrix-install-openclaw","utf8");
  expect(installer).toContain("matrix-configure-openclaw-shared-browser.mjs");
  expect(installer).toContain("systemctl is-active --quiet matrix-openclaw-gateway.service");
  expect(installer).toContain("deferred to gateway startup");
});

it("bootstraps a missing allowlist only for the explicitly enabled Matrix plugin", async () => {
  const f = await fixture(); try {
    for (const plugins of [undefined, { entries: f.initial.plugins.entries }]) {
      await writeFile(f.configPath, JSON.stringify({ ...f.initial, plugins }));
      expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "installed" });
      const current = JSON.parse(await readFile(f.configPath, "utf8"));
      expect(current.plugins.allow).toEqual([ID]);
      expect(current.models).toEqual(f.initial.models);
      expect(current.gateway).toEqual(f.initial.gateway);
      await rm(join(f.stateDir, ".matrix-shared-browser-installed.json"));
    }
    await writeFile(f.configPath, JSON.stringify({ ...f.initial, plugins: { allow: null } }));
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
  } finally { await f.close(); }
});

it("suppresses Matrix protocol auto-install from Matrix OS environment variables during shared browser bootstrap", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options);
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    // Pinned native OpenClaw treats any nonempty MATRIX_* key as channel presence.
    const matrixOsEnv = { MATRIX_HOME: f.root, MATRIX_BROWSER_LAB: "true" };
    const nativeDetectsMatrixChannel = Object.entries(matrixOsEnv).some(([key, value]) => key.startsWith("MATRIX_") && value.length > 0);
    expect(nativeDetectsMatrixChannel).toBe(true);
    expect(config.channels).toEqual({ matrix: { enabled: false } });
    expect(config.plugins.allow).toEqual([ID]);
    const before = await readFile(f.configPath);
    await configureOpenClawSharedBrowser(f.options);
    expect(await readFile(f.configPath)).toEqual(before);
  } finally { await f.close(); }
});

it("preserves existing owner channel settings and only defaults an absent Matrix protocol channel", async () => {
  const f = await fixture(); try {
    for (const matrix of [{ enabled: true, homeserver: "https://owner.invalid", accessToken: "synthetic-owner-token" }, { enabled: false }, {}]) {
      const channels = { matrix, slack: { enabled: false, ownerOption: "keep" } };
      await writeFile(f.configPath, JSON.stringify({ ...f.initial, channels }));
      await configureOpenClawSharedBrowser(f.options);
      expect(JSON.parse(await readFile(f.configPath, "utf8")).channels).toEqual(channels);
      await rm(join(f.stateDir, ".matrix-shared-browser-installed.json"));
    }
    await writeFile(f.configPath, JSON.stringify({ ...f.initial, channels: { slack: { enabled: false } } }));
    await configureOpenClawSharedBrowser(f.options);
    expect(JSON.parse(await readFile(f.configPath, "utf8")).channels).toEqual({ slack: { enabled: false }, matrix: { enabled: false } });
  } finally { await f.close(); }
});

it("rejects malformed channel configuration without replacing owner configuration", async () => {
  const f = await fixture(); try {
    for (const channels of [null, [], "invalid", { matrix: null }, { matrix: [] }, { matrix: "invalid" }, { matrix: { enabled: "invalid" } }]) {
      await writeFile(f.configPath, JSON.stringify({ ...f.initial, channels }));
      const before = await readFile(f.configPath);
      await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
      expect(await readFile(f.configPath)).toEqual(before);
    }
  } finally { await f.close(); }
});

it("preserves exact owner-uninstalled config bytes and file identity when plugins or allowlist are absent", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options);
    const markerPath = join(f.stateDir, ".matrix-shared-browser-installed.json");
    const marker = await readFile(markerPath);
    for (const plugins of [undefined, {}, { entries: f.initial.plugins.entries }]) {
      const removed = { ...f.initial, plugins };
      const bytes = Buffer.from(JSON.stringify(removed, null, 4) + "\n");
      await writeFile(f.configPath, bytes);
      const before = await stat(f.configPath, { bigint: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "owner_uninstalled" });
        expect(await readFile(f.configPath)).toEqual(bytes);
        const after = await stat(f.configPath, { bigint: true });
        expect({ ino: after.ino, mtime: after.mtimeNs, uid: after.uid, gid: after.gid, mode: after.mode })
          .toEqual({ ino: before.ino, mtime: before.mtimeNs, uid: before.uid, gid: before.gid, mode: before.mode });
        expect(await readFile(markerPath)).toEqual(marker);
      }
    }
  } finally { await f.close(); }
});

it("starts the host wrapper after owner uninstall with missing plugins or allowlist without restoring the bridge or changing config bytes", async () => {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const { chmod } = await import("node:fs/promises");
  const run = promisify(execFile), f = await fixture(); try {
    const appDir = join(f.root, "app"), entryDir = join(appDir, "packages/gateway/dist/chat"), prefix = join(f.root, "node"), nodeDir = join(prefix, "bin");
    await mkdir(entryDir, { recursive: true }); await mkdir(nodeDir, { recursive: true }); await symlink(process.execPath, join(nodeDir, "node"));
    await writeFile(join(entryDir, "openclaw-shared-browser-plugin-entry.js"), `export const OPENCLAW_SHARED_BROWSER_MANIFEST=${JSON.stringify(OPENCLAW_SHARED_BROWSER_MANIFEST)};`);
    const native = join(nodeDir, "openclaw"), started = join(f.root, "started");
    await writeFile(native, `#!/usr/bin/env bash
set -euo pipefail
[ ! -e "$OPENCLAW_STATE_DIR/extensions/${ID}/index.mjs" ]
printf 'started' > '${started}'
`); await chmod(native, 0o755);
    const auth = join(f.root, "auth.env"); await writeFile(auth, `OPENCLAW_GATEWAY_TOKEN=${"a".repeat(64)}\n`);
    const env = { ...process.env, MATRIX_RUNTIME_HOME: f.root, MATRIX_NODE_PREFIX: prefix, OPENCLAW_STATE_DIR: f.stateDir, OPENCLAW_CONFIG_PATH: f.configPath, OPENCLAW_ENV_FILE: auth, OPENCLAW_BIN: native,
      MATRIX_OPENCLAW_BROWSER_CONFIGURER: resolve("distro/customer-vps/host-bin/matrix-configure-openclaw-shared-browser.mjs"), MATRIX_APP_DIR: appDir, MATRIX_BROWSER_LAB: "true", PORT: "4000", TMPDIR: f.root };
    await configureOpenClawSharedBrowser(f.options);
    await rm(join(f.stateDir, "extensions", ID), { recursive: true });
    for (const plugins of [undefined, {}, { entries: f.initial.plugins.entries }, { load: { paths: [] } }]) {
      const bytes = Buffer.from(JSON.stringify({ ...f.initial, plugins }, null, 4) + "\n"); await writeFile(f.configPath, bytes);
      const before = await stat(f.configPath, { bigint: true });
      await expect(run("bash", ["distro/customer-vps/host-bin/matrix-openclaw-gateway"], { env, timeout: 5_000 })).resolves.toBeDefined();
      expect(await readFile(started, "utf8")).toBe("started"); await rm(started);
      await expect(run("bash", ["distro/customer-vps/host-bin/matrix-openclaw-gateway"], { env: { ...env, MATRIX_BROWSER_LAB: "false" }, timeout: 5_000 })).resolves.toBeDefined();
      await rm(started);
      expect(await readFile(f.configPath)).toEqual(bytes);
      const after = await stat(f.configPath, { bigint: true }); expect(after.ino).toBe(before.ino); expect(after.mtimeNs).toBe(before.mtimeNs);
      await expect(readFile(join(f.stateDir, "extensions", ID, "index.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const pluginPath = join(f.stateDir, "extensions", ID);
    // Empty native allowlists are nonrestrictive: leftover extension sources must fail closed.
    for (const leftover of ["directory", "index", "dangling-symlink", "parent-symlink"]) {
      if (leftover === "parent-symlink") {
        await rm(join(f.stateDir, "extensions"), { recursive: true });
        await symlink(join(f.root, "missing-extensions"), join(f.stateDir, "extensions"));
      } else if (leftover === "dangling-symlink") await symlink(join(f.root, "missing-plugin"), pluginPath);
      else { await mkdir(pluginPath); if (leftover === "index") await writeFile(join(pluginPath, "index.mjs"), "// leftover"); }
      const bytes = Buffer.from(JSON.stringify({ ...f.initial, plugins: {} })); await writeFile(f.configPath, bytes);
      await expect(run("bash", ["distro/customer-vps/host-bin/matrix-openclaw-gateway"], { env, timeout: 5_000 })).rejects.toMatchObject({ code: 3 });
      await expect(readFile(started)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(f.configPath)).toEqual(bytes);
      if (leftover === "parent-symlink") { await rm(join(f.stateDir, "extensions")); await mkdir(join(f.stateDir, "extensions")); }
      else await rm(pluginPath, { recursive: true, force: true });
    }
    for (const plugins of [{ allow: null }, { allow: ["foreign"] }, { allow: "invalid" }, { load: { paths: ["/foreign/plugin"] } }]) {
      const bytes = Buffer.from(JSON.stringify({ ...f.initial, plugins })); await writeFile(f.configPath, bytes);
      await expect(run("bash", ["distro/customer-vps/host-bin/matrix-openclaw-gateway"], { env, timeout: 5_000 })).rejects.toMatchObject({ code: 3 });
      await expect(readFile(started)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(f.configPath)).toEqual(bytes);
    }
    for (const policy of [{ gateway: { ...f.initial.gateway, bind: "all" } }, { tools: { deny: [] } }]) {
      const bytes = Buffer.from(JSON.stringify({ ...f.initial, ...policy, plugins: {} })); await writeFile(f.configPath, bytes);
      await expect(run("bash", ["distro/customer-vps/host-bin/matrix-openclaw-gateway"], { env, timeout: 5_000 })).rejects.toMatchObject({ code: 3 });
      await expect(readFile(started)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(f.configPath)).toEqual(bytes);
    }
    await writeFile(f.configPath, JSON.stringify({ ...f.initial, plugins: {} }));
    await expect(run("bash", ["distro/customer-vps/host-bin/matrix-openclaw-gateway"], { env: { ...env, MATRIX_OPENCLAW_BROWSER_CONFIGURER: join(f.root, "missing-configurer"), MATRIX_BROWSER_LAB: "false" }, timeout: 5_000 })).rejects.toMatchObject({ code: 3 });
    await expect(readFile(started)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
}, 15_000);

it("upgrades only a fingerprinted legacy managed index to inject the official native resolver", async () => {
  const f = await fixture(); try {
    await configureOpenClawSharedBrowser(f.options);
    const dir = join(f.stateDir, "extensions", ID), markerPath = join(f.stateDir, ".matrix-shared-browser-installed.json");
    const legacyIndex = `export { default } from ${JSON.stringify(f.options.compiledEntry)};\n`;
    await writeFile(join(dir, "index.mjs"), legacyIndex);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.files["index.mjs"] = createHash("sha256").update(legacyIndex).digest("hex");
    await writeFile(markerPath, JSON.stringify(marker));
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    config.plugins.installs = { [ID]: { source: "path", sourcePath: dir, installPath: dir, version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" } };
    await writeFile(f.configPath, JSON.stringify(config));
    const before = await readFile(f.configPath);
    const customIndex = "// owner customized index\n";
    await writeFile(join(dir, "index.mjs"), customIndex);
    await writeFile(markerPath, JSON.stringify({ ...marker, files: { ...marker.files, "index.mjs": createHash("sha256").update(customIndex).digest("hex") } }));
    await expect(configureOpenClawSharedBrowser(f.options)).rejects.toThrow();
    expect(await readFile(f.configPath)).toEqual(before);
    expect(await readFile(join(dir, "index.mjs"), "utf8")).toBe(customIndex);
    await writeFile(join(dir, "index.mjs"), legacyIndex); await writeFile(markerPath, JSON.stringify(marker));
    await expect(configureOpenClawSharedBrowser({ ...f.options, beforeConfigCommit: async () => { throw new Error("synthetic interruption"); } })).rejects.toThrow("synthetic interruption");
    expect(await readFile(f.configPath)).toEqual(before);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(marker);
    expect(await readFile(join(dir, "index.mjs"), "utf8")).toBe(`import { resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";\nimport { createOpenClawSharedBrowserPlugin } from ${JSON.stringify(f.options.compiledEntry)};\nexport default createOpenClawSharedBrowserPlugin(resolveGatewayAuth);\n`);
    expect(await configureOpenClawSharedBrowser(f.options)).toMatchObject({ state: "installed" });
    delete config.plugins.installs;
    expect(JSON.parse(await readFile(f.configPath, "utf8"))).toEqual(config);
    const index = await readFile(join(dir, "index.mjs"), "utf8");
    expect(index).toBe(`import { resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";\nimport { createOpenClawSharedBrowserPlugin } from ${JSON.stringify(f.options.compiledEntry)};\nexport default createOpenClawSharedBrowserPlugin(resolveGatewayAuth);\n`);
    const updated = JSON.parse(await readFile(markerPath, "utf8"));
    expect(updated.files["index.mjs"]).toBe(createHash("sha256").update(index).digest("hex"));
  } finally { await f.close(); }
});
