import { TerminalHostLaunchSchema } from "./host-descriptor.js";
import type { PreparedWorkspaceTerminalLaunch } from "./workspace-launch.js";
import { agentLaunchTerminalCommand } from "../coding-agents/agent-launch-environment.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { TerminalNativeHostRefSchema, TerminalTabSchema, TerminalTabIdSchema, TerminalWorkspaceIdSchema, type TerminalRef, type TerminalTab } from "@matrix-os/contracts";
import { TerminalRuntimeError, TerminalWorkspaceStore } from "@matrix-os/terminal-runtime";
import { boundedOperation } from "../bounded-operation.js";
import { SAFE_PRINCIPAL_USER_ID, type RequestPrincipal } from "../request-principal.js";
import type { RoutineCliRuntime } from "../bots/routine-cli-runtime.js";
import type { RoutineSourcePolicy } from "../bots/routine-action-source-registry.js";
import type { TerminalWorkspaceRouteRuntime } from "../shell/workspace-routes.js";
import { createTerminalRoutineSource } from "./routine-source.js";
import { terminalUnavailable } from "./host-channel.js";
import { TerminalHostStartError, type createTerminalHostService } from "./host-service.js";
import type { RetainedTerminalStartup, TerminalSourcePort } from "./retained-binding.js";
import { terminalNativeOrdinaryCommand, TerminalManagedLaunchSchema, type TerminalManagedLaunch, type createTerminalNativeLauncher } from "./native-launch.js";
import type { readLinuxProcess } from "./process-identity.js";
export interface CanonicalTerminalLaunchInput { tabId?: string; name: string; cwd: string; managedLaunch: TerminalManagedLaunch }
export interface CanonicalTerminalLaunch {
  launch(principal: RequestPrincipal, workspaceId: string, input: CanonicalTerminalLaunchInput): Promise<TerminalTab>;
  launchPrepared(input: PreparedWorkspaceTerminalLaunch): Promise<TerminalTab>;
  fence(ref: TerminalRef): void;
  fenceWorkspace(workspaceId: string): void;
  available(ref: TerminalRef): Promise<boolean>;
  close(): Promise<void>;
}
/** Authenticated Gateway composition only. Public UDS/descriptor/restore data never calls this factory. */
export function createCanonicalTerminalLaunch(options: {
  runtime: Pick<TerminalWorkspaceRouteRuntime, "listWorkspaces" | "createTab" | "prepareNativeTab" | "completeNativeTab">;
  host?: Pick<ReturnType<typeof createTerminalHostService>, "start">;
  launcher: Pick<ReturnType<typeof createTerminalNativeLauncher>, "build">;
  /** Trusted composition only. Production interactive equivalence needs private configuration handoff. */
  interactiveHostEquivalent?: boolean;
  homePath: string; generation: string; computerId: string; ownerIds: readonly string[];
  routines?: { runtime: Pick<RoutineCliRuntime, "register">; binPath: string; endpoint: string };
  readProcess?: typeof readLinuxProcess;
}): CanonicalTerminalLaunch {
  type Entry = { ref: TerminalRef; end(): void; close(): Promise<void>; current(): Promise<boolean> };
  const entries = new Map<string, Entry>(); // <=32 private proofs; eviction on end, expiry and shutdown. Never caps I/O sessions.
  const pending = new Map<string, { digest: string; work: Promise<TerminalTab> }>(); // <=64 admissions, removed on settlement.
  let closed = false;
  const canonicalStore = new TerminalWorkspaceStore({ homePath: options.homePath });
  const keyOf = (ref: TerminalRef) => `${ref.workspaceId}:${ref.tabId}`;
  async function readTab(ref: TerminalRef) {
    const workspaces = await boundedOperation(() => options.runtime.listWorkspaces(), 5000);
    return workspaces.find(workspace => workspace.id === ref.workspaceId)?.tabs.find(tab => tab.id === ref.tabId);
  }
  async function start(principal: RequestPrincipal, workspaceId: string, input: CanonicalTerminalLaunchInput, prepared?: PreparedWorkspaceTerminalLaunch): Promise<TerminalTab> {
    const ref = { workspaceId, tabId: input.tabId! }, key = keyOf(ref);
    const existing = await readTab(ref);
    if (existing) return existing; // Repeated client tab identity never starts a second native root or restores proof.
    if (!prepared && (!options.host || options.interactiveHostEquivalent !== true)) return options.runtime.createTab(workspaceId, {
      tabId: ref.tabId, name: input.name, cwd: input.cwd, accessScope: "owner", agent: { providerId: input.managedLaunch.harness },
      command: terminalNativeOrdinaryCommand(input.managedLaunch),
    });
    const launch = prepared ? TerminalHostLaunchSchema.parse(prepared.launch) : await options.launcher.build(input.managedLaunch, input.cwd);
    if (!options.host) return options.runtime.createTab(workspaceId, { tabId: ref.tabId, name: input.name, cwd: input.cwd,
      accessScope: "owner", agent: { providerId: input.managedLaunch.harness }, command: agentLaunchTerminalCommand(launch) });
    if (!options.runtime.prepareNativeTab || !options.runtime.completeNativeTab) throw new TerminalRuntimeError("unavailable");
    const controller = new AbortController(); let retained: RetainedTerminalStartup | undefined;
    let source: ReturnType<typeof createTerminalRoutineSource> | undefined, canonical: TerminalTab | undefined;
    let expiry: NodeJS.Timeout | undefined;
    let expectedHost: import("@matrix-os/contracts").TerminalNativeHostRef | undefined;
    let admittedIncarnation: string | undefined, settlementToken: string | undefined;
    let dispatchSettled = false;
    async function settle(outcome: "never-dispatched" | "settled" | "uncertain", attach: boolean) {
      if (!expectedHost || !admittedIncarnation || !settlementToken) throw new TerminalRuntimeError("unavailable");
      const token = settlementToken; settlementToken = undefined; // One attempt, including response loss.
      return options.runtime.completeNativeTab!(ref, { expectedIncarnation: admittedIncarnation, nativeHost: expectedHost,
        settlementToken: token, outcome, attach });
    }
    const end = () => { if (controller.signal.aborted) return; controller.abort(); clearTimeout(expiry); source?.end(); retained?.retire(); if (entries.get(key)?.end === end) entries.delete(key); };
    const close = async () => { end(); await source?.close(); };
    const privateCurrent = () => !closed && !controller.signal.aborted && !!retained && retained.current() && !retained.signal.aborted && retained.identity.generation === options.generation;
    async function currentRecord() {
      if (!privateCurrent() || !canonical?.incarnation || !expectedHost || !admittedIncarnation) { end(); return false; }
      // Transaction checks read only the local atomic canonical record, never UDS/manager RPC.
      let current: TerminalTab | undefined;
      try { current = await boundedOperation(() => canonicalStore.getTab(ref), 1000); }
      catch (error) { end(); throw error; }
      const valid = privateCurrent() && current?.incarnation === admittedIncarnation && current.createdAt === canonical.createdAt
        && current.accessScope === "owner" && ["running", "idle"].includes(current.status)
        && current.nativeHost?.path === expectedHost.path && current.nativeHost?.generation === expectedHost.generation
        && !current.nativeHost.stopRequested && !current.nativeHost.dispatchPending;
      if (!valid) end();
      return valid;
    }
    // This transitional port is authority-free until this reserved record is finalized.
    const port: TerminalSourcePort = { end, close, invoke: (operation, writer, signal) => {
      if (!privateCurrent()) { end(); return Promise.resolve(terminalUnavailable(operation)); }
      return source ? source.invoke(operation, writer, signal) : Promise.resolve(terminalUnavailable(operation));
    } };
    let result: Awaited<ReturnType<NonNullable<typeof options.host>["start"]>>;
    try {
      result = await options.host.start({ launch, cols: 120, rows: 36,
        async onPrepared(reference) {
          expectedHost = TerminalNativeHostRefSchema.parse({ path: reference.path, generation: options.generation });
          const reserved = await options.runtime.prepareNativeTab!(workspaceId, { tabId: ref.tabId, name: input.name, cwd: input.cwd,
            agent: { providerId: input.managedLaunch.harness }, nativeHost: expectedHost });
          settlementToken = reserved.settlementToken;
          canonical = TerminalTabSchema.parse(reserved.tab);
          if (canonical.id !== ref.tabId || canonical.workspaceId !== workspaceId || canonical.status !== "starting"
            || !canonical.incarnation || !canonical.nativeHost?.dispatchPending || canonical.nativeHost.path !== expectedHost.path
            || canonical.nativeHost.generation !== expectedHost.generation || canonical.nativeHost.stopRequested) throw new TerminalRuntimeError("conflict");
          admittedIncarnation = canonical.incarnation;
        },
        onDispatchSettled: () => { dispatchSettled = true; },
        async onBound(startup) {
        if (closed || entries.size >= 32 || !options.computerId || !options.routines || !["jwt", "platform-verified"].includes(principal.source)
          || !options.ownerIds.includes(principal.userId) || startup.identity.generation !== options.generation || !startup.current() || startup.signal.aborted) return undefined;
        retained = startup;
        startup.signal.addEventListener("abort", end, { once: true });
        controller.signal.addEventListener("abort", () => startup.signal.removeEventListener("abort", end), { once: true });
        entries.set(key, { ref, end, close, current: currentRecord });
        expiry = setTimeout(end, 30 * 60000); expiry.unref();
        return port; // Never waits for createTab, never manufactures an interim source/Chat/run.
      } });
      if (!expectedHost || !admittedIncarnation || result.reference.path !== expectedHost.path) throw new TerminalRuntimeError("unavailable");
      canonical = TerminalTabSchema.parse(await settle(dispatchSettled ? "settled" : "uncertain", true));
      if (canonical.id !== ref.tabId || canonical.workspaceId !== workspaceId || canonical.incarnation !== admittedIncarnation
        || canonical.nativeHost?.path !== result.reference.path || canonical.nativeHost.generation !== expectedHost.generation
        || !privateCurrent() || !await retained!.verifyCurrent() || !await currentRecord()) { await close(); return canonical; }
      const policy: RoutineSourcePolicy = prepared?.policy ?? { live: true, scope: "personal", interactionMode: "default", permissionMode: "supervised", originCeiling: "exact", revision: "terminal-native-exact-v1" };
      source = createTerminalRoutineSource({ ...options.routines!, computerId: options.computerId, homePath: options.homePath,
        admission: { principal, harness: input.managedLaunch.harness, sessionId: key, incarnationId: canonical.incarnation!, launchId: randomUUID(),
          generation: createHash("sha256").update(retained!.heldGeneration).digest("hex"), supervisor: retained!.identity.supervisor, host: retained!.identity.host, root: retained!.identity.root, policy },
        signal: AbortSignal.any([controller.signal, retained!.signal]), current: privateCurrent, validateCurrent: currentRecord, preflightCurrent: () => retained!.verifyCurrent(), readProcess: options.readProcess });
      return canonical;
    } catch (error) {
      await close();
      // Only the actual host lifecycle can prove no dispatch. Otherwise preserve
      // uncertainty; neither return/throw nor missing descriptor is absence proof.
      if (expectedHost && admittedIncarnation && settlementToken) {
        try {
          const current = await canonicalStore.getTab(ref);
          if (current?.nativeHost?.dispatchPending) await settle(error instanceof TerminalHostStartError && error.phase === "never-dispatched"
            ? "never-dispatched" : dispatchSettled ? "settled" : "uncertain", false);
        } catch (cleanupError) { console.warn("[terminal-launch] Pending recovery retained", cleanupError instanceof Error ? cleanupError.name : "UnknownError"); }
      }
      settlementToken = undefined;
      throw error; // No native stop, retry or fallback after possible dispatch.
    }
  }
  function admit(rawPrincipal: RequestPrincipal, workspaceInput: string, rawInput: CanonicalTerminalLaunchInput, prepared?: PreparedWorkspaceTerminalLaunch) {
      const principal = { ...rawPrincipal }, workspaceId = TerminalWorkspaceIdSchema.parse(workspaceInput);
      if (closed || !SAFE_PRINCIPAL_USER_ID.test(principal.userId) || !options.ownerIds.includes(principal.userId)) return Promise.reject(new TerminalRuntimeError("unavailable"));
      const input = { ...rawInput, managedLaunch: TerminalManagedLaunchSchema.parse(rawInput.managedLaunch), tabId: rawInput.tabId ? TerminalTabIdSchema.parse(rawInput.tabId) : `tt_${randomUUID().replaceAll("-", "")}` };
      const key = keyOf({ workspaceId, tabId: input.tabId }), digest = JSON.stringify([principal, input]), old = pending.get(key);
      if (old) return old.digest === digest ? old.work : Promise.reject(new TerminalRuntimeError("conflict"));
      if (pending.size >= 64) return Promise.reject(new TerminalRuntimeError("capacity"));
      const work = start(principal, workspaceId, input, prepared).finally(() => pending.delete(key)); pending.set(key, { digest, work }); return work;
  }
  return {
    launch: admit,
    launchPrepared(prepared) { return admit(prepared.principal, prepared.workspaceId, { name: prepared.name, cwd: prepared.cwd, managedLaunch: { harness: prepared.harness } }, structuredClone(prepared)); },
    fence(ref) { entries.get(keyOf(ref))?.end(); },
    fenceWorkspace(workspaceId) { for (const entry of entries.values()) if (entry.ref.workspaceId === workspaceId) entry.end(); },
    async available(ref) { const entry = entries.get(keyOf(ref)); return entry ? entry.current() : false; },
    async close() { closed = true; const draining = [...entries.values()].map(entry => entry.close()); await Promise.allSettled(draining); },
  };
}
