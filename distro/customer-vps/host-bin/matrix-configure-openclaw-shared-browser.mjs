#!/usr/bin/env node
/** Run only during coordinated stopped-service install or gateway startup, never alongside native config writes. */
import { open, mkdir, lstat, realpath, rename, link, unlink, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ID = 'matrix-shared-browser', MARKER = '.matrix-shared-browser-installed.json', LOCK = '.matrix-shared-browser.lock';
const MAX_BYTES = 1024 * 1024;
const unavailable = () => new Error('OpenClaw browser configuration unavailable');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const owned = stat => stat.uid === process.getuid?.() && !stat.isSymbolicLink();
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function directory(path, create = false) {
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = await lstat(path); if (!stat.isDirectory() || !owned(stat)) throw unavailable();
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const current = await handle.stat(); if (current.ino !== stat.ino || current.dev !== stat.dev) { await handle.close(); throw unavailable(); }
  // Linux production pins every relative file operation to the verified directory descriptor.
  const access = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : await realpath(path);
  return { path, access, handle };
}
async function read(path, max = MAX_BYTES) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { const stat = await handle.stat(); if (!stat.isFile() || !owned(stat) || stat.size > max) throw unavailable();
    const bytes = await handle.readFile(); if (bytes.length > max) throw unavailable(); return bytes;
  } finally { await handle.close(); }
}
async function sweep(dir) {
  let examined = 0; const stream = await opendir(dir.access);
  for await (const entry of stream) {
    if (++examined > 512) break;
    if (!/^\.matrix-browser-tmp-[a-f0-9]{32}$/.test(entry.name)) continue;
    const path = join(dir.access,entry.name); let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isFile() && owned(stat) && Date.now()-stat.mtimeMs > 120_000) await unlink(path);
  }
}
async function writeAtomic(dir, name, content, expected) {
  const destination = join(dir.access,name), temporary = join(dir.access,`.matrix-browser-tmp-${randomBytes(16).toString('hex')}`);
  const bytes = Buffer.from(content); if (bytes.length > MAX_BYTES) throw unavailable();
  let handle;
  try {
    handle = await open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle=undefined;
    const current = await read(destination);
    if ((current === null) !== (expected === null) || current && !current.equals(expected)) throw unavailable();
    // The fingerprint detects edits before replacement; it is not a cross-writer CAS.
    // Native writes are excluded by the stopped-service/startup coordination boundary.
    if (expected === null) { await link(temporary,destination); await unlink(temporary); }
    else await rename(temporary,destination);
  } finally {
    await handle?.close();
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function acquireLock(state) {
  const path=join(state.access,LOCK);
  for (let attempt=0;attempt<2;attempt++) {
    try { const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await file.writeFile(JSON.stringify({pid:process.pid,createdAt:Date.now()})); await file.sync();
      const stat=await file.stat(); await file.close();
      return async()=>{const current=await lstat(path);if(current.ino!==stat.ino||current.dev!==stat.dev||!owned(current))throw unavailable();await unlink(path);};
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      const stat=await lstat(path);if(!stat.isFile()||!owned(stat))throw unavailable();
      let dead=false;const bytes=await read(path,512);
      try { const value=JSON.parse(bytes.toString());if(Number.isSafeInteger(value.pid)&&value.pid>1) {try{process.kill(value.pid,0);}catch(liveError){if(liveError.code==='ESRCH')dead=true;else if(liveError.code!=='EPERM')throw liveError;}} }
      catch(parseError){if(!(parseError instanceof SyntaxError))throw parseError;}
      if(!dead&&Date.now()-stat.mtimeMs<=120_000)throw unavailable();
      const current=await lstat(path);if(current.ino!==stat.ino||current.dev!==stat.dev||!owned(current))throw unavailable();await unlink(path);
    }
  }
  throw unavailable();
}
function mapping(value) { return value && typeof value==='object' && !Array.isArray(value); }
export async function configureOpenClawSharedBrowser(options) {
  if(options.disabledMarker&&await exists(options.disabledMarker))return{state:'harness_disabled'};
  const statePath=resolve(options.stateDir),configPath=resolve(options.configPath);
  if(dirname(configPath)!==statePath||!Number.isInteger(options.gatewayPort)||options.gatewayPort<1||options.gatewayPort>65535)throw unavailable();
  const state=await directory(statePath);let release;const directories=[];
  try {
    release=await acquireLock(state);await sweep(state);
    const configName=basename(configPath),original=await read(join(state.access,configName));
    if(original===null)return{state:'awaiting_gateway_startup'};
    const markerBytes=await read(join(state.access,MARKER),4096);const marker=markerBytes?JSON.parse(markerBytes.toString()):null;
    if(marker&&(!mapping(marker)||marker.version!==1||!mapping(marker.files)))throw unavailable();
    const parsed=JSON.parse(original.toString('utf8'));if(!mapping(parsed)||parsed.plugins!==undefined&&!mapping(parsed.plugins))throw unavailable();
    const plugins=parsed.plugins??{};
    const allow=plugins.allow===undefined?[]:plugins.allow;
    if(!Array.isArray(allow)||allow.some(value=>value!==ID)||new Set(allow).size!==allow.length)throw unavailable();
    let config={...parsed,plugins:{...plugins,allow}};
    if(config.plugins.entries!==undefined&&!mapping(config.plugins.entries))throw unavailable();
    const entries=config.plugins.entries??{},entry=entries[ID];
    if(entry!==undefined&&(!mapping(entry)||Object.keys(entry).some(key=>!['enabled','config'].includes(key))||entry.enabled!==undefined&&typeof entry.enabled!=='boolean'
      ||entry.config!==undefined&&(!mapping(entry.config)||Object.keys(entry.config).some(key=>key!=='gatewayPort'))))throw unavailable();
    if(config.plugins.deny!==undefined&&(!Array.isArray(config.plugins.deny)||config.plugins.deny.some(value=>typeof value!=='string')))throw unavailable();
    // Pinned native OpenClaw rejects plugins.installs even while the plugin is disabled.
    // Remove only a complete receipt from this earlier Matrix bootstrap.
    const legacy=config.plugins.installs!==undefined;
    // An owner uninstall must not normalize or rewrite their remaining configuration.
    if(marker&&!entry&&!legacy)return{state:'owner_uninstalled'};
    let pluginPath, plugin, files, previous;
    if(legacy||options.enabled) {
      if(typeof options.compiledEntry!=='string'||!options.compiledEntry.startsWith('/')||!options.compiledEntry.endsWith('/packages/gateway/dist/chat/openclaw-shared-browser-plugin-entry.js'))throw unavailable();
      const manifest=options.manifest;
      if(!mapping(manifest)||manifest.id!==ID||JSON.stringify(manifest.contracts?.tools)!=='["shared_browser"]'||manifest.activation?.onStartup!==true)throw unavailable();
      const extensionPath=join(state.path,'extensions');pluginPath=join(extensionPath,ID);
      if(config.plugins.load?.paths!==undefined&&(!Array.isArray(config.plugins.load.paths)||config.plugins.load.paths.some(value=>value!==pluginPath)))throw unavailable();
      const installation=config.plugins.installs?.[ID];
      if(legacy&&(!mapping(config.plugins.installs)||Object.keys(config.plugins.installs).length!==1||!mapping(installation)
        ||Object.keys(installation).length!==5||Object.keys(installation).some(key=>!['source','sourcePath','installPath','version','installedAt'].includes(key))
        ||installation.source!=='path'||installation.sourcePath!==pluginPath||installation.installPath!==pluginPath
        ||installation.version!==manifest.version||typeof installation.installedAt!=='string'
        ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(installation.installedAt)
        ||!Number.isFinite(Date.parse(installation.installedAt))||new Date(installation.installedAt).toISOString()!==installation.installedAt
        ||Date.parse(installation.installedAt)>Date.now()||!marker||Object.keys(marker).length!==2
        ||Object.keys(marker.files).sort().join(',')!=='index.mjs,openclaw.plugin.json,package.json'))throw unavailable();
      const extensions=await directory(join(state.access,'extensions'),!legacy);directories.push(extensions);
      plugin=await directory(join(extensions.access,ID),!legacy);directories.push(plugin);await sweep(plugin);
      files={
        'index.mjs':`import { resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";\nimport { createOpenClawSharedBrowserPlugin } from ${JSON.stringify(options.compiledEntry)};\nexport default createOpenClawSharedBrowserPlugin(resolveGatewayAuth);\n`,
        'package.json':JSON.stringify({name:'@matrix-os/openclaw-shared-browser',version:'1.0.0',type:'module',openclaw:{extensions:['./index.mjs']}},null,2)+'\n',
        'openclaw.plugin.json':JSON.stringify(manifest,null,2)+'\n',
      };
      previous={};
      for(const[name,content]of Object.entries(files)) {
        const current=await read(join(plugin.access,name));previous[name]=current;
        const legacyIndexBytes=Buffer.from(`export { default } from ${JSON.stringify(options.compiledEntry)};\n`);
        const legacyIndex=name==='index.mjs'&&current?.equals(legacyIndexBytes);
        const interruptedUpgrade=name==='index.mjs'&&current?.equals(Buffer.from(content))&&marker?.files[name]===hash(legacyIndexBytes);
        if(legacy&&(!current||(!current.equals(Buffer.from(content))&&!legacyIndex)||marker.files[name]!==hash(current)&&!interruptedUpgrade))throw unavailable();
        if(marker&&current===null)return{state:'owner_uninstalled'};
        if(current&&!current.equals(Buffer.from(content))&&marker?.files[name]!==hash(current))throw unavailable();
      }
      if(legacy) { const {installs:_legacyReceipt,...nativePlugins}=config.plugins;config={...config,plugins:nativePlugins}; }
    }
    if(!options.enabled) {
      if(!config.plugins.allow.includes(ID)) { if(JSON.stringify(config)!==JSON.stringify(parsed))await writeAtomic(state,configName,JSON.stringify(config,null,2)+'\n',original);return{state:'feature_disabled'}; }
      const next={...config,plugins:{...config.plugins,allow:[]}};
      await options.beforeConfigCommit?.();await writeAtomic(state,configName,JSON.stringify(next,null,2)+'\n',original);return{state:'feature_disabled'};
    }
    if(entry?.enabled===false||config.plugins.enabled===false||config.plugins.deny?.includes(ID)) { if(JSON.stringify(config)!==JSON.stringify(parsed))await writeAtomic(state,configName,JSON.stringify(config,null,2)+'\n',original);return{state:'owner_disabled'}; }
    if(marker&&!entry) {
      if(JSON.stringify(config)!==JSON.stringify(parsed))await writeAtomic(state,configName,JSON.stringify(config,null,2)+'\n',original);
      return{state:'owner_uninstalled'};
    }
    if(config.channels!==undefined&&!mapping(config.channels))throw unavailable();
    const ownerChannels=config.channels??{};
    if(Object.hasOwn(ownerChannels,'matrix')&&(!mapping(ownerChannels.matrix)
      ||ownerChannels.matrix.enabled!==undefined&&typeof ownerChannels.matrix.enabled!=='boolean'))throw unavailable();
    // Native OpenClaw detects any MATRIX_* variable as Matrix protocol channel presence.
    // Matrix OS owns that namespace; default only an absent channel to an explicit opt-out.
    const channels=Object.hasOwn(ownerChannels,'matrix')?ownerChannels:{...ownerChannels,matrix:{enabled:false}};
    for(const[name,content]of Object.entries(files))if(!previous[name]?.equals(Buffer.from(content)))await writeAtomic(plugin,name,content,previous[name]);
    const next={...config,channels,plugins:{...config.plugins,allow:[ID],entries:{...entries,[ID]:{...entry,enabled:true,config:{gatewayPort:options.gatewayPort}}}}};
    await options.beforeConfigCommit?.();
    if(JSON.stringify(next)!==JSON.stringify(parsed))await writeAtomic(state,configName,JSON.stringify(next,null,2)+'\n',original);
    const markerContent=JSON.stringify({version:1,files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,hash(Buffer.from(content))]))})+'\n';
    if(!markerBytes?.equals(Buffer.from(markerContent)))await writeAtomic(state,MARKER,markerContent,markerBytes);
    return{state:'installed',pluginPath};
  } finally {try {await release?.();} finally {for(const dir of directories.reverse())await dir.handle.close();await state.handle.close();}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==2)throw unavailable();
    const stateDir=process.env.OPENCLAW_STATE_DIR??join(process.env.MATRIX_RUNTIME_HOME??process.env.MATRIX_HOME??'/home/matrix/home','.openclaw');
    const enabled=process.env.MATRIX_BROWSER_LAB==='true';
    const compiledEntry=join(process.env.MATRIX_APP_DIR??'/opt/matrix/app','packages/gateway/dist/chat/openclaw-shared-browser-plugin-entry.js');
    const manifest=(await import(pathToFileURL(compiledEntry).href)).OPENCLAW_SHARED_BROWSER_MANIFEST;
    const result=await configureOpenClawSharedBrowser({stateDir,configPath:process.env.OPENCLAW_CONFIG_PATH??join(stateDir,'openclaw.json'),enabled,
      gatewayPort:Number(process.env.PORT??4000),compiledEntry,manifest,disabledMarker:join(process.env.MATRIX_RUNTIME_CONTROL_STATE_DIR??'/var/lib/matrix-agent-runtime','disabled-openclaw')});
    console.log(`matrix-openclaw-browser: ${result.state}`);
  } catch(error) {console.error('matrix-openclaw-browser: configuration unavailable',error instanceof Error?error.name:'UnknownError');process.exitCode=3;}
}
