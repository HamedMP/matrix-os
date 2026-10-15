import { randomUUID } from 'node:crypto';
import { SharedBrowserActionSchema, type SharedBrowserAction, type SharedBrowserActionResult } from '@matrix-os/contracts';
import { SharedBrowserError, type SharedBrowserDriver } from './broker.js';
import { BrowserCdpMissingObjectError, BrowserCdpMissingTargetError, connectBrowserCdp, type BrowserCdpClient, type CdpConnectOptions, type CdpEvent } from './cdp-client.js';
import { CURSOR_ACTION_FUNCTION, CLEAR_CURSOR_FUNCTION } from './cdp-cursor.js';
import { ACTION_FUNCTION, SNAPSHOT_FUNCTION } from './cdp-dom.js';
import { collectChromeDownload, cleanupDownloadTemps } from './cdp-downloads.js';
import { validateBrowserUrl, type BrowserResolver } from './url-policy.js';

interface Observation { id: string; document: string; frameId: string; contextId: number; url: string; refs: Set<string>; generation: number }
export function createSharedBrowserCdpDriver(options: CdpConnectOptions & { homePath: string; resolveHost?: BrowserResolver }): SharedBrowserDriver {
  let client: BrowserCdpClient | undefined, connecting: Promise<BrowserCdpClient> | undefined;
  let targetId: string | undefined, sessionId: string | undefined, observation: Observation | undefined;
  let generation = 0, detaching = false, recoveryRequired = false;
  const owned = new Map<string, number>(); // <=8 agent-created tabs, 24h idle-ID eviction; no owner-tab scan.
  const paused = new Map<string, Promise<void>>(); // <=16 Fetch requests, DNS 2s + CDP 8s eviction.
  const children = new Map<string, { targetId: string; type: string; newlyPaused: boolean }>(); // <=16 related sessions, detached/run-close eviction.
  const childJobs = new Set<Promise<void>>(); // <=16 bounded initializations/duplicate detaches, settlement/close eviction.
  const blockedDownloadJobs = new Set<Promise<void>>(); // <=8 denied download cancellations, settlement/close eviction.
  const intentionalDetach = new Set<string>(); // <=17 current sessions; command settlement eviction.
  let handoffRequired = false, collectingDownload = false;
  let unsubscribe: (() => unknown) | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  const report = (error: unknown) => console.warn('[shared-browser] Chrome operation unavailable', error instanceof SharedBrowserError ? error.code : 'operation_failed');
  // Only agent-owned targets reach this helper. A new visible tab must be
  // observable before its first navigation; arbitrary schemes remain denied.
  const ownedUrl = (url:string) => url === 'about:blank' ? Promise.resolve({url,sourceUrl:url}) : validateBrowserUrl(url,options.resolveHost);
  let cursorDocument: { document:string; session:string; target:string } | undefined;
  let clearingCursor: Promise<void> = Promise.resolve();
  const clearCursor = () => {
    const cursor=cursorDocument;
    if (!cursor || !client?.available) return clearingCursor;
    cursorDocument=undefined;
    const transport=client;
    clearingCursor=clearingCursor.catch(report).then(async()=>{
      try { await transport.request('Runtime.callFunctionOn',{objectId:cursor.document,functionDeclaration:CLEAR_CURSOR_FUNCTION,arguments:[],
        returnByValue:true,awaitPromise:false},cursor.session,AbortSignal.timeout(2000)); }
      catch(error) {
        if (error instanceof BrowserCdpMissingObjectError) {
          try {
            // The old object may be gone after navigation. Clear any remaining
            // decoration through the currently attached document before release.
            const tree=await transport.request('Page.getFrameTree',{},cursor.session,AbortSignal.timeout(2000));
            if(typeof tree.frameTree?.frame?.id!=='string')throw new SharedBrowserError('browser_unavailable');
            const world=await transport.request('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'matrix-shared-browser'},cursor.session,AbortSignal.timeout(2000));
            if(!Number.isSafeInteger(world.executionContextId))throw new SharedBrowserError('browser_unavailable');
            const cleared=await transport.request('Runtime.evaluate',{expression:`(${CLEAR_CURSOR_FUNCTION}).call(document)`,contextId:world.executionContextId,returnByValue:true},cursor.session,AbortSignal.timeout(2000));
            if(cleared.exceptionDetails || cleared.result?.value?.ok!==true)throw new SharedBrowserError('browser_unavailable');
            return;
          } catch(recoveryError) { error=recoveryError; }
        }
        if (!cursorDocument && owned.has(cursor.target)) cursorDocument=cursor;
        throw error;
      }
    });
    void clearingCursor.catch(report);return clearingCursor;
  };
  const invalidateObservation = () => { generation++; observation = undefined; void clearCursor(); };
  const forgetTarget = (id: string) => {
    if (!owned.delete(id)) return;
    if (targetId === id) { cursorDocument=undefined;clearingCursor=clearingCursor.catch(report);targetId = undefined; sessionId = undefined; invalidateObservation(); }
  };
  const handoff = (): SharedBrowserActionResult & { handoffRequested: true } => ({ success: false, handoffRequested: true, targetId, elements: [], content: 'The owner must take over Chrome and review this page before automation continues. A related browser target could not be safely controlled.' });
  const expireTargets = () => {
    for (const [id, touched] of owned) if (Date.now() - touched >= 24 * 60 * 60_000) {
      owned.delete(id); if (targetId === id) { targetId = undefined; invalidateObservation(); }
    }
  };
  const request = (method: string, params: Record<string, unknown>, signal?: AbortSignal, browser = false) => {
    if (!client || !client.available) return Promise.reject(new SharedBrowserError('browser_unavailable'));
    return client.request(method, params, browser ? undefined : sessionId, signal);
  };
  async function targetInfo(id: string, signal: AbortSignal) {
    try { return await request('Target.getTargetInfo', { targetId: id }, signal, true); }
    catch (error) { if (!(error instanceof BrowserCdpMissingTargetError)) throw error; forgetTarget(id); return null; }
  }
  async function reconcileTargets(signal: AbortSignal) {
    for (const id of owned.keys()) await targetInfo(id, signal);
  }
  async function detachSession(id: string, signal?: AbortSignal) {
    intentionalDetach.add(id);
    try { await request('Target.detachFromTarget', { sessionId: id }, signal, true); }
    finally { intentionalDetach.delete(id); }
  }
  async function network(event: CdpEvent) {
    const id = event.params.requestId;
    const key = `${event.sessionId}:${id}`;
    if (typeof id !== 'string' || id.length > 128 || paused.has(key)) return;
    const boundSession = event.sessionId;
    const reject = () => client?.request('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }, boundSession);
    if (detaching || paused.size >= 16) { await reject(); return; }
    const job = (async () => {
      try {
        await validateBrowserUrl(event.params.request?.url, options.resolveHost);
        if (detaching) await reject();
        else await client?.request('Fetch.continueRequest', { requestId: id }, boundSession);
      } catch (error) {
        // Every redirected request is intercepted again. No request headers,
        // cookies, body, credential-bearing URLs or response text leave this gate.
        if (!(error instanceof SharedBrowserError)) report(error);
        await reject();
      }
    })();
    paused.set(key, job);
    try { await job; } finally { paused.delete(key); }
  }
  function related(event: CdpEvent) {
    const { sessionId: child, targetInfo: info, waitingForDebugger } = event.params;
    if (typeof child !== 'string' || child.length > 128 || !info || typeof info.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(info.targetId) || children.size >= 16 || childJobs.size >= 16) { handoffRequired = true; invalidateObservation(); return; }
    // Chrome can auto-attach a second session to the page we already own and
    // control. Release only that duplicate; it is not a newly related target.
    if (typeof sessionId === 'string' && sessionId.length > 0 && child.length > 0 && child !== sessionId && event.sessionId === sessionId
      && info.type === 'page' && info.targetId === targetId && owned.has(info.targetId)
      && waitingForDebugger === false) {
      const job = detachSession(child).catch(error => {
        report(error); handoffRequired = true; invalidateObservation();
      });
      childJobs.add(job); void job.finally(() => childJobs.delete(job));
      return;
    }
    children.set(child, { targetId: info.targetId, type: info.type, newlyPaused: waitingForDebugger === true });
    // Existing shared/service workers may belong to other owner tabs. Do not
    // inspect, resume, terminate or close them. Unsupported targets hand off.
    // Related-target interception is not whole-profile network isolation:
    // Chrome resolves DNS separately and initial child requests require live
    // qualification. The controller never promises containment of owner tabs.
    if (!['page', 'iframe'].includes(info.type) || waitingForDebugger !== true) { handoffRequired = true; invalidateObservation(); return; }
    const job = (async () => {
      try {
        if (info.url !== 'about:blank') await validateBrowserUrl(info.url, options.resolveHost);
        if (detaching) return;
        await client!.request('Page.enable', {}, child);
        await client!.request('Network.setBypassServiceWorker', { bypass: true }, child);
        await client!.request('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, child);
        await client!.request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child);
        if (detaching) return;
        if (info.type === 'page') {
          if (owned.size >= 8) { handoffRequired = true; invalidateObservation(); return; }
          owned.set(info.targetId, Date.now());
        }
        await client!.request('Runtime.runIfWaitingForDebugger', {}, child);
      } catch (error) { report(error); handoffRequired = true; invalidateObservation(); }
    })();
    childJobs.add(job); void job.finally(() => childJobs.delete(job));
  }
  async function detachChildren() {
    await Promise.all(childJobs);
    for (const [child, info] of children) {
      if (['page', 'iframe'].includes(info.type)) {
        await client!.request('Fetch.disable', {}, child);
        await client!.request('Network.setBypassServiceWorker', { bypass: false }, child);
        await client!.request('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, child);
      } else if (info.newlyPaused) {
        // Release only the startup pause we introduced on a NEW related worker,
        // after agent work has drained and the controller is handing off.
        // Never resume an existing/nonwaiting owner worker.
        await client!.request('Runtime.runIfWaitingForDebugger', {}, child);
      }
      await detachSession(child);
    }
    children.clear();
  }
  function event(event: CdpEvent) {
    if (event.method === 'Browser.downloadWillBegin' && !collectingDownload) {
      const guid = event.params.guid;
      if (typeof guid !== 'string' || guid.length > 128 || blockedDownloadJobs.size >= 8) { handoffRequired = true; invalidateObservation(); return; }
      const job = client!.request('Browser.cancelDownload', { guid }).then(() => undefined, error => {
        report(error); handoffRequired = true; invalidateObservation();
      });
      blockedDownloadJobs.add(job); void job.finally(() => blockedDownloadJobs.delete(job));
      return;
    }
    if (event.method === 'Target.targetDestroyed' && owned.has(event.params.targetId)) { forgetTarget(event.params.targetId); return; }
    // A browser-global primary attachment can arrive before its response.
    // It has no parent session and is not a scoped related-target attachment.
    const knownSession = typeof event.sessionId === 'string' && event.sessionId.length > 0
      && (event.sessionId === sessionId || children.has(event.sessionId));
    if (event.method === 'Target.attachedToTarget' && knownSession) { related(event); return; }
    if (event.method === 'Target.detachedFromTarget' && children.has(event.params.sessionId)) {
      const child = children.get(event.params.sessionId)!;
      if (!intentionalDetach.has(event.params.sessionId)) forgetTarget(child.targetId);
      children.delete(event.params.sessionId); return;
    }
    if (event.method === 'Fetch.requestPaused' && knownSession) { void network(event).catch(report); return; }
    if (event.method === 'Target.detachedFromTarget' && event.params.sessionId === sessionId) {
      if (!intentionalDetach.has(sessionId!)) { recoveryRequired=true;void client?.close().catch(report); }
      invalidateObservation(); sessionId = undefined; return;
    }
    if (event.sessionId !== sessionId) return;
    if (['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Runtime.executionContextsCleared', 'Runtime.executionContextDestroyed', 'DOM.documentUpdated'].includes(event.method)) invalidateObservation();
  }
  async function connect() {
    if (client?.available) return;
    if (client) {
      unsubscribe?.(); unsubscribe = undefined; sessionId = undefined; invalidateObservation();
      if (children.size || childJobs.size) handoffRequired = true;
      await Promise.all(childJobs); children.clear(); paused.clear();
    }
    detaching = false;
    if (!maintenance) {
      await cleanupDownloadTemps(options.homePath);
      maintenance = setInterval(() => { expireTargets(); void cleanupDownloadTemps(options.homePath).catch(report); }, 15 * 60_000);
      maintenance.unref();
    }
    connecting ??= connectBrowserCdp(options);
    try { client = await connecting; unsubscribe = client.onEvent(event); }
    finally { connecting = undefined; }
  }
  async function attach(target: string, signal: AbortSignal) {
    invalidateObservation();
    if (children.size || childJobs.size) await detachChildren();
    if (sessionId) {
      await request('Fetch.disable', {}, signal); await request('Network.setBypassServiceWorker', { bypass: false }, signal);
      await request('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, signal);
      await detachSession(sessionId, signal); sessionId = undefined;
    }
    targetId = target; owned.set(target, Date.now());
    let attached: Record<string, any>;
    try { attached = await request('Target.attachToTarget', { targetId: target, flatten: true }, signal, true); }
    catch (error) { if (error instanceof BrowserCdpMissingTargetError) forgetTarget(target); throw error; }
    if (typeof attached.sessionId !== 'string' || attached.sessionId.length > 128) throw new SharedBrowserError('browser_unavailable');
    sessionId = attached.sessionId;
    await request('Page.enable', {}, signal); await request('Runtime.enable', {}, signal); await request('DOM.enable', {}, signal);
    await request('Network.setBypassServiceWorker', { bypass: true }, signal);
    await request('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, signal);
    await request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, signal);
    await request('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }, signal, true);
    await request('Target.activateTarget', { targetId: target }, signal, true);
  }
  async function newTab(signal: AbortSignal) {
    await reconcileTargets(signal);
    if (owned.size >= 8) throw new SharedBrowserError('browser_busy');
    const result = await request('Target.createTarget', { url: 'about:blank', background: false }, signal, true);
    if (typeof result.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.targetId)) throw new SharedBrowserError('browser_unavailable');
    owned.set(result.targetId, Date.now()); await attach(result.targetId, signal);
  }
  async function frame(signal: AbortSignal) {
    const tree = await request('Page.getFrameTree', {}, signal);
    const current = tree.frameTree?.frame;
    if (!current || typeof current.id !== 'string' || typeof current.url !== 'string') throw new SharedBrowserError('browser_unavailable');
    const checked = await ownedUrl(current.url);
    return { id: current.id as string, url: checked.url, sourceUrl: checked.sourceUrl };
  }
  async function call(document: string, declaration: string, args: unknown[], signal: AbortSignal) {
    const result = await request('Runtime.callFunctionOn', { objectId: document, functionDeclaration: declaration,
      arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: declaration === CURSOR_ACTION_FUNCTION, userGesture: true }, signal);
    if (result.exceptionDetails || !result.result?.value || typeof result.result.value !== 'object') throw new SharedBrowserError('browser_unavailable');
    return result.result.value as Record<string, any>;
  }
  async function snapshot(signal: AbortSignal): Promise<SharedBrowserActionResult> {
    invalidateObservation(); await clearingCursor.catch(report); const current = await frame(signal); const snapshotGeneration = generation;
    const world = await request('Page.createIsolatedWorld', { frameId: current.id, worldName: 'matrix-shared-browser' }, signal);
    if (!Number.isSafeInteger(world.executionContextId)) throw new SharedBrowserError('browser_unavailable');
    await request('Runtime.releaseObjectGroup', { objectGroup: 'matrix-observation' }, signal);
    const doc = await request('Runtime.evaluate', { expression: 'document', contextId: world.executionContextId, objectGroup: 'matrix-observation', returnByValue: false }, signal);
    if (typeof doc.result?.objectId !== 'string') throw new SharedBrowserError('browser_unavailable');
    const id = randomUUID(); const value = await call(doc.result.objectId, SNAPSHOT_FUNCTION, [id], signal);
    if (snapshotGeneration !== generation) throw new SharedBrowserError('observe_again');
    if (value.handoff === true) return { ...handoff(), url: current.sourceUrl, content: 'The owner must sign in or approve authentication using Take over before automation continues.' };
    if (typeof value.content !== 'string' || value.content.length > 16000 || typeof value.title !== 'string' || value.title.length > 160 || !Array.isArray(value.elements) || value.elements.length > 100) throw new SharedBrowserError('browser_unavailable');
    const elements: Array<{ ref: string; role: string; name: string }> = value.elements.map((row: unknown) => {
      if (!row || typeof row !== 'object' || !('ref' in row) || !('role' in row) || !('name' in row) || typeof row.ref !== 'string' || !/^r\d{1,3}$/.test(row.ref) || typeof row.role !== 'string' || row.role.length > 40 || typeof row.name !== 'string' || row.name.length > 180) throw new SharedBrowserError('browser_unavailable');
      return { ref: row.ref, role: row.role, name: row.name };
    });
    observation = { id, document: doc.result.objectId, frameId: current.id, contextId: world.executionContextId, url: current.url, refs: new Set(elements.map(row => row.ref)), generation };
    return { success: true, observationId: id, targetId, url: current.sourceUrl, title: value.title, content: value.content, elements };
  }
  async function execute(raw: SharedBrowserAction, signal: AbortSignal): Promise<SharedBrowserActionResult> {
    signal.throwIfAborted(); const parsed = SharedBrowserActionSchema.safeParse(raw);
    if (!parsed.success) throw new SharedBrowserError('invalid_action'); const input = parsed.data;
    expireTargets();
    await connect(); await Promise.all(childJobs); signal.throwIfAborted();
    if (input.action === 'status') return { success: client!.available };
    if (handoffRequired) { if (input.action === 'snapshot') return handoff(); throw new SharedBrowserError('browser_changed'); }
    if (input.action === 'tab_switch') {
      if (!owned.has(input.targetId)) throw new SharedBrowserError('invalid_action');
      const info = await targetInfo(input.targetId, signal); if (!info) throw new SharedBrowserError('observe_again'); await ownedUrl(info.targetInfo?.url);
      await attach(input.targetId, signal); return { success: true, targetId };
    }
    if (input.action === 'tabs') {
      const tabs = [];
      for (const id of owned.keys()) {
        const info = await targetInfo(id, signal); if (!info) continue;
        const checked = await ownedUrl(info.targetInfo?.url);
        tabs.push({ targetId: id, title: '', url: checked.sourceUrl });
      }
      return { success: true, tabs };
    }
    if (input.action === 'tab_new') {
      if (input.url) await validateBrowserUrl(input.url, options.resolveHost);
      await newTab(signal);
      if (input.url) { const result = await request('Page.navigate', { url: input.url }, signal); invalidateObservation(); if (result.errorText) throw new SharedBrowserError('browser_unavailable'); }
      return { success: true, targetId };
    }
    const grounded = ['click', 'type', 'select', 'wait', 'download'].includes(input.action);
    if (grounded && (!observation || !('observationId' in input) || observation.id !== input.observationId || observation.generation !== generation)) throw new SharedBrowserError('observe_again');
    if (targetId && !sessionId) {
      const current = targetId;
      if (await targetInfo(current, signal)) {
        try { await attach(current, signal); }
        catch (error) { if (!(error instanceof BrowserCdpMissingTargetError) || input.action !== 'snapshot') throw error; }
      }
    }
    if (!targetId) { if (grounded) throw new SharedBrowserError('observe_again'); await newTab(signal); }
    owned.set(targetId!, Date.now());
    if (input.action === 'navigate') {
      const checked = await validateBrowserUrl(input.url, options.resolveHost); invalidateObservation();
      const result = await request('Page.navigate', { url: checked.url }, signal);
      if (result.errorText) throw new SharedBrowserError('browser_unavailable');
      if (handoffRequired) return handoff();
      return { success: true, targetId, url: checked.sourceUrl };
    }
    if (input.action === 'snapshot') return snapshot(signal);
    const observed = observation;
    if (!observed || observed.id !== input.observationId || !observed.refs.has(input.ref) || observed.generation !== generation) throw new SharedBrowserError('observe_again');
    const current = await frame(signal);
    if (current.id !== observed.frameId || current.url !== observed.url || observed.generation !== generation) { invalidateObservation(); throw new SharedBrowserError('observe_again'); }
    if (input.action === 'wait') {
      const deadline = Date.now() + (input.timeout ?? 5000);
      for (;;) {
        if (observed.generation !== generation) throw new SharedBrowserError('observe_again');
        const result = await call(observed.document, ACTION_FUNCTION, [observed.id, input.ref, 'wait', null], signal);
        if (result.ok) return { success: true, targetId };
        if (result.reason !== 'waiting') { invalidateObservation(); throw new SharedBrowserError('observe_again'); }
        if (Date.now() >= deadline) throw new SharedBrowserError('browser_unavailable');
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
          const aborted = () => { cleanup(); reject(new SharedBrowserError('browser_changed')); };
          const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(100, deadline - Date.now()));
          signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
        });
      }
    }
    const inspected = await call(observed.document, ACTION_FUNCTION, [observed.id, input.ref, 'inspect', null], signal);
    if (!inspected.ok) { invalidateObservation(); throw new SharedBrowserError('observe_again'); }
    if (inspected.href) await validateBrowserUrl(inspected.href, options.resolveHost);
    if (observed.generation !== generation) throw new SharedBrowserError('observe_again');
    const decorate = () => { if (sessionId && targetId) cursorDocument={document:observed.document,session:sessionId,target:targetId}; };
    if (input.action === 'download') {
      if (typeof inspected.href !== 'string') throw new SharedBrowserError('invalid_action');
      const artifact = await collectChromeDownload({ homePath: options.homePath, client: client!, frameId: observed.frameId, sourceUrl: inspected.href,
        documentId: input.documentId, signal, resolveHost: options.resolveHost, restoreBehavior: 'deny',
        onCollectingChange: collecting => { collectingDownload = collecting; },
        trigger: async () => { decorate(); const result = await call(observed.document, CURSOR_ACTION_FUNCTION, [observed.id, input.ref, 'click', null], signal); if (!result.ok) throw new SharedBrowserError('observe_again'); } });
      if ('recoveryPath' in artifact) return { ...handoff(), content: `Chrome started additional downloads. Its files were preserved for owner review in ${artifact.recoveryPath}. Automation must stop until the owner reviews this recovery folder.` };
      return { success: true, targetId, artifact };
    }
    decorate();
    const result = await call(observed.document, CURSOR_ACTION_FUNCTION, [observed.id, input.ref, input.action, input.action === 'type' ? input.text : input.action === 'select' ? input.value : null], signal);
    if (!result.ok) { invalidateObservation(); throw new SharedBrowserError('observe_again'); }
    if (handoffRequired) return handoff();
    return { success: true, targetId };
  }
  async function detach() {
    detaching = true; invalidateObservation(); await clearingCursor.catch(error=>{if(client?.available)throw error;report(error);});
    clearInterval(maintenance); maintenance = undefined;
    if (connecting) { try { client = await connecting; } catch (error) { report(error); } }
    if (client && !client.available) {
      recoveryRequired=true;unsubscribe?.();unsubscribe=undefined;await client.close();client=undefined;sessionId=undefined;
    }
    if (!client) {
      sessionId=undefined;
      if(!recoveryRequired)return;
      // A fresh fixed transport must acknowledge cleanup before owner input
      // can be enabled after an uncertain disconnect. Never close Chrome.
      const recovery=await connectBrowserCdp(options);
      try{
        const cursor=cursorDocument;
        if(cursor && owned.has(cursor.target)) {
          let cleanupSession:string|undefined;
          try {
            const attached=await recovery.request('Target.attachToTarget',{targetId:cursor.target,flatten:true});
            if(typeof attached.sessionId!=='string')throw new SharedBrowserError('browser_unavailable');cleanupSession=attached.sessionId;
            const tree=await recovery.request('Page.getFrameTree',{},cleanupSession);
            if(typeof tree.frameTree?.frame?.id!=='string')throw new SharedBrowserError('browser_unavailable');
            const world=await recovery.request('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'matrix-shared-browser'},cleanupSession);
            if(!Number.isSafeInteger(world.executionContextId))throw new SharedBrowserError('browser_unavailable');
            const cleared=await recovery.request('Runtime.evaluate',{expression:`(${CLEAR_CURSOR_FUNCTION}).call(document)`,contextId:world.executionContextId,returnByValue:true},cleanupSession);
            if(cleared.exceptionDetails || cleared.result?.value?.ok!==true)throw new SharedBrowserError('browser_unavailable');
          } catch(error) { if(!(error instanceof BrowserCdpMissingTargetError))throw error;forgetTarget(cursor.target); }
          finally { if(cleanupSession)await recovery.request('Target.detachFromTarget',{sessionId:cleanupSession}); }
          cursorDocument=undefined;
        }
        await recovery.request('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:false});recoveryRequired=false;
      }
      finally{await recovery.close();paused.clear();children.clear();childJobs.clear();blockedDownloadJobs.clear();handoffRequired=false;}
      return;
    }
    recoveryRequired=true;
    try {
      await Promise.all(paused.values()); await Promise.all(blockedDownloadJobs);
      await detachChildren();
      if (sessionId) {
        await request('Fetch.disable', {}); await request('Network.setBypassServiceWorker', { bypass: false });
        await request('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
        await detachSession(sessionId);
      }
      await request('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false }, undefined, true);
      recoveryRequired=false;
    } finally { unsubscribe?.(); unsubscribe = undefined; await client.close(); client = undefined; sessionId = undefined; paused.clear(); children.clear(); childJobs.clear(); blockedDownloadJobs.clear(); handoffRequired = false; }
  }
  return { execute, invalidateObservation, detach };
}
