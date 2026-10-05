import type { createPiSettingsConnection } from "./pi-settings-auth.js";
import type { createOpenClawSettingsConnection } from "./openclaw-settings-auth.js";
import type { createOpenCodeSettingsConnection } from "./opencode-settings-auth.js";
import type { createClaudeSettingsLogin } from "./provider-workflow-browser.js";
import type { createCodexSettingsLogin } from "./provider-workflow-codex-login.js";
import type { NativeProviderProfileGuard } from "./native-provider-profile-guard.js";
import type { ProviderKeyVerifier } from "./provider-workflow-key.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CODEX_VERIFIED_NPM_PACKAGE, type TerminalRef, type AiProviderSnapshotV3 } from '@matrix-os/contracts';
import type { TerminalRuntimeSocketClient } from '@matrix-os/terminal-runtime';
import type { ProviderSettingsStoreWriter } from './provider-settings-store.js';
import { ProviderWorkflowError, ProviderWorkflowNotStartedError, type ProviderWorkflowAdapter } from './provider-workflows.js';
/** Extract only the known device flow. Raw terminal output never leaves this adapter. */
export function extractProviderDeviceCode(raw: string): {
  authorizationUrl: string;
  deviceCode: string;
} | null {
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-16384);
  const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device(?=\s|$)/)?.[0];
  const code = text.match(/\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/)?.[1];
  return url && code ? { authorizationUrl: url, deviceCode: code } : null;
}
const packages = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex', opencode: 'opencode-ai', pi: '@earendil-works/pi-coding-agent' } as const;
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
export async function createNativeProviderWorkflowAdapters(options: {
  store: ProviderSettingsStoreWriter;
  terminal: Pick<TerminalRuntimeSocketClient, 'ensureWorkspace' | 'createTab' | 'terminateTab' | 'attach' | 'listWorkspaces'>;
  runtimePrefix?: string;
  hermesCodexReuse?: () => Promise<void>;
  claudeBrowserLogin?: ReturnType<typeof createClaudeSettingsLogin>;
  codexSettingsLogin?: ReturnType<typeof createCodexSettingsLogin>;
  piConnection?: ReturnType<typeof createPiSettingsConnection>;
  openclawConnection?: ReturnType<typeof createOpenClawSettingsConnection>;
  opencodeConnection?: ReturnType<typeof createOpenCodeSettingsConnection>;
  profileGuard?: NativeProviderProfileGuard;
  inventory?: () => Promise<AiProviderSnapshotV3['drivers']>;
  hostControl?: {
    available: boolean;
    run(action: 'cancel-install', harness: 'hermes' | 'openclaw'): Promise<void>;
  };
  verifyKeys?: Partial<Record<'codex' | 'claude' | 'opencode' | 'pi' | 'hermes' | 'openclaw', ProviderKeyVerifier>>;
}): Promise<ProviderWorkflowAdapter[]> {
  if (!options.store || !options.terminal)
    throw new Error('Native workflow dependencies required');
  const prefix = resolve(options.runtimePrefix ?? '/opt/matrix/runtime/node');
  // Never uninstall arbitrary owner/local executables. Only a real, fixed managed runtime tree.
  let managed = false;
  if (prefix === '/opt/matrix/runtime/node') {
    try {
      const metadata = await lstat(prefix);
      managed = metadata.isDirectory() && !metadata.isSymbolicLink() && await realpath(prefix) === prefix;
    }
    catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[provider-workflow] Managed prefix unavailable:', error instanceof Error ? error.name : 'UnknownError');
    }
  }
  // Only a foreground Connect completion records new enablement intent. Catalog
  // reads and native credential observation never restore an owner's old Off.
  const enableConnectedHarness = async (id: string, key: string) => {
    const current = await options.store.getSnapshot({ refresh: true });
    const exact = current.harnesses.find(row => row.id === id);
    if (!exact || current.access.mode !== 'writable') throw new ProviderWorkflowError('unavailable');
    if (exact.enabled) return;
    await options.store.mutate({ type: 'set_harness_enabled', harnessInstanceId: id,
      enabled: true, expectedRevision: current.revision, idempotencyKey: key });
  };
  const snapshot = await options.store.getSnapshot();
  const hostControl = options.hostControl ?? await nativeHostControl();
  if (snapshot.access.mode !== 'writable')
    return [];
  const inventory = options.inventory ? await options.inventory() : [];
  const rows: Array<Pick<typeof snapshot.harnesses[number], 'id' | 'harness' | 'displayName' | 'installState' | 'loginMethods' | 'selectedAccountId'>> = [...snapshot.harnesses];
  for (const driver of inventory) {
    const kind = driver.id === 'claude_code' ? 'claude' : driver.id;
    if (!['claude', 'codex', 'pi', 'opencode', 'hermes', 'openclaw'].includes(kind) || rows.some(row => row.harness === kind))
      continue;
    rows.push({ id: `harness_${driver.id}`, harness: kind as typeof rows[number]['harness'], displayName: driver.displayName, installState: driver.installState, loginMethods: [], selectedAccountId: null });
  }
  return Promise.all(rows.map(async harness => {
    let opencodeCapability = { login: false, apiKey: false };
    if (harness.harness === "opencode" && harness.installState === "installed" && options.opencodeConnection) {
      try { opencodeCapability = await options.opencodeConnection.capabilities(); }
      catch (error) { console.warn("[provider-workflow] OpenCode auth capabilities unavailable:", error instanceof Error ? error.name : "UnknownError"); }
    }
    if (harness.harness === "pi" && harness.installState === "installed" && options.piConnection) {
      try { opencodeCapability = await options.piConnection.capabilities(); }
      catch (error) { console.warn("[provider-workflow] Pi auth capabilities unavailable:", error instanceof Error ? error.name : "UnknownError"); }
    }
    if (harness.harness === "openclaw" && harness.installState === "installed" && options.openclawConnection) {
      opencodeCapability = await options.openclawConnection.capabilities();
    }
    const settingsConnection = harness.harness === "openclaw" ? options.openclawConnection : harness.harness === "pi" ? options.piConnection : options.opencodeConnection;
    const packageName = harness.harness in packages ? packages[harness.harness as keyof typeof packages] : null;
    const canReuseCodex = harness.harness === 'hermes' && harness.installState === 'installed' && !!options.hermesCodexReuse;
    const canLogin = harness.installState === 'installed' && harness.loginMethods.includes('terminal') && ['codex', 'claude'].includes(harness.harness);
    const canBrowserLogin = canLogin && harness.harness === 'claude' && !!options.claudeBrowserLogin;
    const system = harness.harness === 'hermes' || harness.harness === 'openclaw';
    const keyAdapter = harness.installState === 'installed' ? options.verifyKeys?.[harness.harness] : undefined;
    return {
      harnessInstanceId: harness.id, harness: harness.harness, displayName: harness.displayName, installState: harness.installState,
      loginMethods: opencodeCapability.login ? ['device_code' as const] : canReuseCodex ? ['existing_codex' as const] : canBrowserLogin ? ['browser' as const, 'terminal' as const] : canLogin ? [harness.harness === 'codex' && options.codexSettingsLogin ? 'device_code' as const : 'terminal' as const] : [],
      apiKeyProviders: opencodeCapability.apiKey ? ['openai' as const] : keyAdapter && ['claude', 'codex'].includes(harness.harness) ? [harness.harness === 'claude' ? 'anthropic' as const : 'openai' as const] : [],
      install: (!!packageName || system && hostControl.available) && harness.installState !== 'installed', uninstall: !!packageName && managed || system && hostControl.available,
      ...(opencodeCapability.apiKey && settingsConnection ? { verifyKey: settingsConnection.verifyKey } : keyAdapter ? { async verifyKey(key) {
        if (keyAdapter.connect) return keyAdapter.connect(key, () => enableConnectedHarness(harness.id, `key-connect-${randomUUID()}`));
        await keyAdapter(key);
        await enableConnectedHarness(harness.id, `key-connect-${randomUUID()}`);
      } } : {}),
      async start({ request, publish, registerCleanup }) {
        if (request.kind === 'login' && request.method === 'device_code' && harness.harness === 'codex') {
          if (!canLogin || !options.codexSettingsLogin) throw new ProviderWorkflowNotStartedError();
          return options.codexSettingsLogin({ publish, registerCleanup, onSuccess: async () => {
            const fresh = await options.store.getSnapshot({ refresh: true, includeNativeAccountMetadata: true });
            const exact = fresh.harnesses.find(row => row.id === harness.id);
            // Native consent and account identity are separate from the
            // harness's execution readiness. Accept only this route's exact
            // authenticated account; local credential presence is insufficient.
            const account = fresh.accounts?.find(row => row.id === exact?.selectedAccountId);
            const source = fresh.accessSources?.find(row => row.id === exact?.accessSourceId);
            const authenticatedAccount = !!account && account.authState === 'authenticated'
              && account.accessSourceId === exact?.accessSourceId
              && account.providerId === exact?.route.providerId
              && source?.accountId === account.id && source.providerId === account.providerId;
            if (!exact || exact.harness !== harness.harness || fresh.access.mode !== 'writable'
              || !(exact.authState === 'authenticated' || authenticatedAccount))
              throw new ProviderWorkflowError('unavailable');
            if (!exact.enabled) {
              // Use the same validated snapshot revision so an account/route
              // change cannot be enabled by a second, unvalidated read.
              await options.store.mutate({ type: 'set_harness_enabled', harnessInstanceId: exact.id,
                enabled: true, expectedRevision: fresh.revision,
                idempotencyKey: `connect-${createHash('sha256').update(request.idempotencyKey).digest('hex')}` });
            }
          } });
        }
        if (request.kind === 'login' && ['pi', 'opencode'].includes(harness.harness)) {
          const loginConnection = harness.harness === "pi" ? options.piConnection : options.opencodeConnection;
          if (!opencodeCapability.login || !loginConnection) throw new ProviderWorkflowNotStartedError();
          return loginConnection.start({ request, publish, registerCleanup });
        }
        if (request.kind === 'login' && request.method === 'browser') {
          if (harness.harness !== 'claude' || !options.claudeBrowserLogin) throw new ProviderWorkflowNotStartedError();
          return options.claudeBrowserLogin({ publish, registerCleanup, onSuccess: async () => {
            const fresh = await options.store.getSnapshot({ refresh: true });
            const exact = fresh.harnesses.find(row => row.id === harness.id);
            if (!exact || !(exact.authState === 'authenticated' || exact.localObservation?.state === 'present_unverified'))
              throw new ProviderWorkflowError('unavailable');
            await enableConnectedHarness(harness.id, `connect-${createHash("sha256").update(request.idempotencyKey).digest("hex")}`);
          } });
        }
        if (request.kind === 'login' && request.method === 'existing_codex') {
          if (!canReuseCodex || !options.hermesCodexReuse) throw new ProviderWorkflowNotStartedError();
          const reuse = async () => {
            await options.hermesCodexReuse!();
            const fresh = await options.store.getSnapshot({ refresh: true });
            const exact = fresh.harnesses.find(row => row.id === harness.id);
            const source = fresh.accessSources.find(row => row.kind === 'harness_profile'
              && row.harness === 'hermes' && row.providerId === 'openai-codex'
              && row.localObservation?.state === 'present_unverified');
            const models = fresh.modelProviders.find(row => row.id === source?.providerId)?.models
              .filter(model => model.enabled && source?.eligibleModelIds.includes(model.id)) ?? [];
            const model = models.find(row => row.id === exact?.route.modelId) ?? models[0];
            if (!exact || !source || !model || !fresh.supportedActions.includes('set_route')
              || !fresh.supportedActions.includes('set_harness_enabled'))
              throw new ProviderWorkflowError('unavailable');
            await options.store.mutate({ type: 'set_route', harnessInstanceId: exact.id,
              route: { kind: 'configurable', providerId: source.providerId, modelId: model.id },
              accessSourceId: source.id, accountId: null, enableHarness: true,
              expectedRevision: fresh.revision, idempotencyKey: `reuse-${createHash("sha256").update(request.idempotencyKey).digest("hex")}` });
          };
          if (options.profileGuard) await options.profileGuard.run('codex', { kind: 'write' }, reuse);
          else await reuse();
          publish({ state: 'succeeded', safeFailure: null });
          return { cancel: async () => {} };
        }
        let releaseProfile: (() => void | Promise<void>) | undefined;
        if (request.kind !== "login" && options.profileGuard && (harness.harness === "codex" || harness.harness === "claude")) releaseProfile = await options.profileGuard.acquire(harness.harness, { kind: "write", durable: true });
        let ref: TerminalRef | undefined;
        let uncertainName: string | undefined;
        let launchMayExist = false;
        registerCleanup(async () => {
          if (!launchMayExist) { await releaseProfile?.(); return; }
          if (!ref && uncertainName) {
            const tab = (await options.terminal.listWorkspaces()).flatMap(w => w.tabs).find(t => t.name === uncertainName);
            if (tab) { ref = { workspaceId: tab.workspaceId, tabId: tab.id }; incarnation = tab.incarnation; }
          }
          if (!ref) throw new ProviderWorkflowError("unavailable");
          await options.terminal.terminateTab(ref!, incarnation); await releaseProfile?.();
        });
        let incarnation: string | undefined;
        if (request.kind === 'login') {
          const fresh = await options.store.getSnapshot();
          const current = fresh.harnesses.find(row => row.id === harness.id);
          if (!current || current.harness !== harness.harness)
            throw new ProviderWorkflowError('unavailable');
          launchMayExist = true;
          const result = await options.store.mutate({ type: 'start_login', harnessInstanceId: harness.id, accountId: current.selectedAccountId, method: 'terminal', expectedRevision: fresh.revision, idempotencyKey: request.idempotencyKey });
          if (result.kind !== 'login_attempt' || result.attempt.action.kind !== 'open_terminal')
            throw new ProviderWorkflowError('unavailable');
          const [workspaceId, tabId] = result.attempt.action.terminalSessionId.split(':');
          ref = { workspaceId: workspaceId!, tabId: tabId! };
          try {
            const matching = (await options.terminal.listWorkspaces()).flatMap(w => w.tabs).find(t => t.workspaceId === workspaceId && t.id === tabId);
            if (!matching)
              throw new ProviderWorkflowError('unavailable');
            incarnation = matching.incarnation;
          }
          catch (error) {
            await options.terminal.terminateTab(ref!, incarnation);
            throw error;
          }
        }
        else {
          let launchRequested = false;
          const tabName = `provider-workflow-native-${harness.harness}-${request.kind}-${randomUUID().slice(0, 8)}`;
          uncertainName = tabName;
          try {
            if (!(packageName || system && hostControl.available) || request.kind === 'uninstall' && !(managed || system && hostControl.available))
              throw new ProviderWorkflowError('unavailable');
            const workspace = await options.terminal.ensureWorkspace();
            const versioned = harness.harness === 'codex' ? CODEX_VERIFIED_NPM_PACKAGE : harness.harness === 'pi' ? `${packageName}@1.0.0` : `${packageName}@latest`;
            const command = system ? `sudo -n /opt/matrix/bin/matrix-agent-runtime-control ${request.kind} ${harness.harness}` : `${quote(`${prefix}/bin/npm`)} ${request.kind === 'install' ? 'install' : 'uninstall'} -g --prefix ${quote(prefix)} ${request.kind === 'uninstall' || harness.harness === 'pi' ? '--ignore-scripts ' : ''}${quote(request.kind === 'install' ? versioned : packageName!)}`;
            launchRequested = true; launchMayExist = true;
            const tab = await options.terminal.createTab(workspace.id, { name: tabName, cwd: '', ...(harness.harness === 'codex' || harness.harness === 'claude' ? { agent: { providerId: harness.harness } } : {}), command: ['sh', '-lc', command] });
            ref = { workspaceId: tab.workspaceId, tabId: tab.id };
            incarnation = tab.incarnation;
          } catch (error) {
            // A launch RPC failure may follow a successful native launch. Keep
            // its lease until restart rechecks durable runtime session liveness.
            if (!launchRequested) await releaseProfile?.();
            else {
              try {
                const launched = (await options.terminal.listWorkspaces()).flatMap(workspace => workspace.tabs).find(tab => tab.name === tabName);
                if (launched) {
                  await options.terminal.terminateTab({ workspaceId: launched.workspaceId, tabId: launched.id }, launched.incarnation);
                  await releaseProfile?.();
                }
              } catch (cleanupError) {
                console.warn('[provider-workflow] Ambiguous launch cleanup unavailable:', cleanupError instanceof Error ? cleanupError.name : 'UnknownError');
              }
            }
            throw error;
          }
        }
        let buffer = '';
        let stopped = false;
        let finishTask: Promise<void> | undefined;
        let cancelling = false;
        let timer: NodeJS.Timeout | undefined;
        let stream: ReturnType<TerminalRuntimeSocketClient['attach']> | undefined;
        const terminate = async () => {
          // Stop the privileged cgroup on both sides of Terminal reaping. The
          // second stop closes the pre-unit-launch race in the host installer.
          const failures: unknown[] = [];
          const host = system && request.kind === 'install';
          if (host)
            try {
              await hostControl.run('cancel-install', harness.harness as 'hermes' | 'openclaw');
            }
            catch (error) {
              failures.push(error);
            }
          try {
            await options.terminal.terminateTab(ref!, incarnation);
          }
          catch (error) {
            failures.push(error);
          }
          if (host)
            try {
              await hostControl.run('cancel-install', harness.harness as 'hermes' | 'openclaw');
            }
            catch (error) {
              failures.push(error);
            }
          if (!failures.length) await releaseProfile?.();
          if (failures.length)
            throw new ProviderWorkflowError('unavailable');
        };
        registerCleanup(async () => { await terminate(); if (finishTask) await finishTask; });
        const failStream = async () => {
          if (stopped || cancelling)
            return;
          cancelling = true;
          try {
            await terminate();
            if (timer)
              clearTimeout(timer);
            stopped = true;
            buffer = '';
            stream?.close();
            publish({ state: 'failed', safeFailure: 'unavailable' });
          }
          catch (error) {
            console.warn('[provider-workflow] Stream cleanup unavailable:', error instanceof Error ? error.name : 'UnknownError');
            publish({ safeFailure: 'unavailable' });
          }
          finally {
            cancelling = false;
          }
        };
        const finish = async (exitCode: number | null) => {
          if (stopped || cancelling)
            return;
          await releaseProfile?.();
          stopped = true;
          if (timer)
            clearTimeout(timer);
          stream?.close();
          buffer = '';
          if (exitCode !== 0) {
            publish({ state: 'failed', safeFailure: 'rejected' });
            return;
          }
          try {
            const confirmed = await options.store.getSnapshot({ refresh: true });
            const exact = confirmed.harnesses.find(row => row.id === harness.id) ?? confirmed.harnesses.find(row => row.harness === harness.harness);
            const installed = exact?.installState ?? confirmed.harnessCatalog.find(row => row.harness === harness.harness)?.installState;
            const success = request.kind === 'login' ? exact?.authState === 'authenticated' || exact?.localObservation?.state === 'present_unverified' : request.kind === 'install' ? installed === 'installed' : installed === 'missing';
            if (success && request.kind === 'login')
              await enableConnectedHarness(harness.id, `connect-${createHash("sha256").update(request.idempotencyKey).digest("hex")}`);
            publish({ state: success ? 'succeeded' : 'failed', safeFailure: success ? null : 'unavailable' });
          }
          catch (error) {
            console.warn('[provider-workflow] Completion probe failed:', error instanceof Error ? error.name : 'UnknownError');
            publish({ state: 'failed', safeFailure: 'unavailable' });
          }
        };
        try {
          stream = options.terminal.attach({ ref: ref!, expectedIncarnation: incarnation, viewerId: `workflow-${randomUUID()}`, mode: 'soft', size: { cols: 100, rows: 30 },
            onFrame(frame) {
              if (stopped)
                return;
              if (frame.type === 'output' || frame.type === 'snapshot') {
                buffer = (buffer + (frame.type === 'output' ? frame.data : frame.ansi)).slice(-16384);
                if (request.kind === 'login' && harness.harness === 'codex') {
                  const code = extractProviderDeviceCode(buffer);
                  if (code)
                    publish(code);
                }
              }
              if (frame.type === 'exit' && !finishTask)
                finishTask = finish(frame.exitCode);
            },
            onClose() { void failStream(); },
            onError(error) { console.warn('[provider-workflow] Terminal stream failed:', error.name); void failStream(); },
          });
        }
        catch (error) {
          await terminate();
          throw error;
        }
        const expire = () => {
          if (stopped)
            return;
          if (cancelling) {
            timer = setTimeout(expire, 30000);
            timer.unref();
            return;
          }
          cancelling = true;
          void terminate().then(() => { stopped = true; buffer = ''; stream?.close(); publish({ state: 'expired', safeFailure: 'expired' }); })
            .catch((error: unknown) => {
            publish({ safeFailure: 'unavailable' });
            console.warn('[provider-workflow] Expiry cleanup unavailable:', error instanceof Error ? error.name : 'UnknownError');
            timer = setTimeout(expire, 30000);
            timer.unref();
          })
            .finally(() => { cancelling = false; });
        };
        if (!stopped) {
          timer = setTimeout(expire, 600000);
          timer.unref();
        }
        return { terminalSessionId: `${ref!.workspaceId}:${ref!.tabId}`, async cancel() {
            if (finishTask) { await finishTask; return; }
            cancelling = true;
            try {
              await terminate();
              stopped = true;
              if (timer)
                clearTimeout(timer);
              stream?.close();
              buffer = '';
            }
            finally {
              cancelling = false;
            }
          } };
      },
    } satisfies ProviderWorkflowAdapter;
  }));
}
async function nativeHostControl() {
  const path = '/opt/matrix/bin/matrix-agent-runtime-control';
  let available = false;
  try {
    const file = await lstat(path);
    available = file.isFile() && !file.isSymbolicLink() && await realpath(path) === path;
  }
  catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('[provider-workflow] Host control unavailable:', error instanceof Error ? error.name : 'UnknownError');
  }
  return { available, async run(action: 'cancel-install', harness: 'hermes' | 'openclaw') { await promisify(execFile)('sudo', ['-n', path, action, harness], { timeout: 30000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true }); } };
}

/** Keep independent native drains running even when one writer cannot be reaped. */
export async function closeNativeProviderWorkflowConnections(close: readonly (() => Promise<void>)[]): Promise<void> {
  await Promise.all(close.map(async drain => {
    try { await drain(); }
    catch (error) { console.warn('[provider-workflow] Native shutdown drain unavailable:', error instanceof Error ? error.name : 'UnknownError'); }
  }));
}
