import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    const dir = join(f.stateDir, "extensions", ID); const pkg = JSON.parse(await readFile(join(dir,"package.json"),"utf8"));
    expect(pkg.openclaw.extensions).toEqual(["./index.mjs"]);
    expect(await readFile(join(dir, "index.mjs"), "utf8")).toContain('export { default } from "/opt/matrix/app/packages/gateway/dist/chat/openclaw-shared-browser-plugin-entry.js"');
    expect(JSON.parse(await readFile(join(dir, "openclaw.plugin.json"), "utf8"))).toEqual(OPENCLAW_SHARED_BROWSER_MANIFEST);
    const bytes = await readFile(f.configPath); await configureOpenClawSharedBrowser(f.options); expect(await readFile(f.configPath)).toEqual(bytes);
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
    expect(JSON.parse(await readFile(f.configPath,"utf8"))).toEqual(f.initial);
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
    const native=join(nodeDir,"openclaw"),started=join(f.root,"started");await writeFile(native,`#!/usr/bin/env bash\nprintf 'started' > '${started}'\n`);await chmod(native,0o755);
    const auth=join(f.root,"auth.env");await writeFile(auth,`OPENCLAW_GATEWAY_TOKEN=${"a".repeat(64)}\n`);
    const env={...process.env,MATRIX_RUNTIME_HOME:f.root,MATRIX_NODE_PREFIX:prefix,OPENCLAW_STATE_DIR:f.stateDir,OPENCLAW_CONFIG_PATH:f.configPath,OPENCLAW_ENV_FILE:auth,OPENCLAW_BIN:native,
      MATRIX_OPENCLAW_BROWSER_CONFIGURER:resolve("distro/customer-vps/host-bin/matrix-configure-openclaw-shared-browser.mjs"),MATRIX_APP_DIR:appDir,MATRIX_BROWSER_LAB:"true",PORT:"4123",TMPDIR:f.root};
    await expect(run("bash",["distro/customer-vps/host-bin/matrix-openclaw-gateway"],{env})).resolves.toBeDefined();
    expect(await readFile(started,"utf8")).toBe("started");expect(JSON.parse(await readFile(f.configPath,"utf8")).plugins.entries[ID].config.gatewayPort).toBe(4123);
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
