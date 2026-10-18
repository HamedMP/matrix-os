import { z } from "zod/v4";
import { importPrompt, importContextLabel } from "@matrix-os/contracts/app-gallery-import";
import type { GalleryApp } from "@matrix-os/contracts/app-gallery";
import type { GallerySyncInput, GallerySyncSnapshot } from "@matrix-os/contracts/app-gallery-sync";
import type { Dispatcher } from "../dispatcher.js";
import type { BotIntegrationConnection } from "../bots/integration-client.js";
import { GallerySyncError, GallerySyncRepository, type GallerySyncLease } from "./sync-repository.js";

export const GallerySyncInputSchema = z.strictObject({
  requestId: z.uuid(),
  accounts: z.array(z.strictObject({ service: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), label: z.string().min(1).max(160),
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), expectedEmail: z.string().max(320).nullable() })).min(1).max(16),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope: z.enum(["personal", "work"]), context: z.string().max(2000), keepUpdated: z.boolean(),
});
const CompletionSchema = z.strictObject({ galleryImport: z.enum(["complete", "partial", "blocked"]), skipped: z.number().int().min(0).max(1_000_000) });
interface Options {
  repository: GallerySyncRepository;
  catalog: () => Promise<readonly GalleryApp[]>;
  installed: (appId: string) => Promise<boolean>;
  inventory: (ownerId: string, signal?: AbortSignal) => Promise<BotIntegrationConnection[]>;
  records: (appId: string, runId: string, startedAt: Date) => Promise<{ added: number; updated: number }>;
  dispatch: Dispatcher["dispatch"];
  probe?: (ownerId: string, selection: GallerySyncInput, signal: AbortSignal) => Promise<Record<string, string> | null>;
  clock?: () => Date;
  ownerIds?: readonly string[];
}
/** Uses the established owner-agent read/import path, with a durable lifecycle around it. */
export class GallerySyncService {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private controller?: AbortController;
  private active?: GallerySyncLease;
  private closed = false;
  constructor(readonly options: Options) {}
  private now() { return this.options.clock?.() ?? new Date(); }
  private async definition(appId: string) {
    const app = (await this.options.catalog()).find(a => a.id === appId);
    if (!app || !app.services.length || !await this.options.installed(appId)) throw new GallerySyncError("denied");
    return app;
  }
  private async validate(ownerId: string, app: GalleryApp, selection: GallerySyncInput, signal?: AbortSignal) {
    const accounts = await this.options.inventory(ownerId, signal);
    try {
      importPrompt(app, selection, accounts.map(a => ({ id: a.connectionId, service: a.service, account_label: a.label, account_email: a.email ?? null, status: "active" })));
      if (new Set(selection.accounts.map(a => `${a.service}:${a.connectionId}`)).size !== selection.accounts.length) throw new Error("Duplicate account");
    } catch (error) {
      console.warn("[gallery-sync] Selected source rejected", error instanceof Error ? error.name : "UnknownError");
      throw new GallerySyncError("denied");
    }
    return accounts;
  }
  async start(ownerId: string, appId: string, raw: unknown): Promise<GallerySyncSnapshot> {
    if (this.closed) throw new GallerySyncError("unavailable");
    const selection = GallerySyncInputSchema.safeParse(raw);
    if (!selection.success) throw new GallerySyncError("invalid");
    const app = await this.definition(appId);
    await this.validate(ownerId, app, selection.data);
    return this.options.repository.configure(ownerId, appId, selection.data, this.now());
  }
  async status(ownerId: string, appId: string) { return (await this.options.repository.get(ownerId, appId))?.snapshot ?? null; }
  async pause(ownerId: string, appId: string) {
    const status = await this.options.repository.pause(ownerId, appId, this.now());
    if (this.active?.ownerId === ownerId && this.active.appId === appId) this.controller?.abort();
    return status;
  }
  async retry(ownerId: string, appId: string, resume = false) {
    const existing = await this.options.repository.get(ownerId, appId);
    if (!existing) throw new GallerySyncError("invalid");
    await this.validate(ownerId, await this.definition(appId), existing.selection);
    return this.options.repository.retry(ownerId, appId, resume, this.now());
  }
  startWorker() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(error => console.error("[gallery-sync] Worker unavailable", error)); }, 2000);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closed || this.work) return Promise.resolve();
    this.work = this.runNext().finally(() => { this.work = undefined; });
    return this.work;
  }
  private async progress(lease: GallerySyncLease, patch: Partial<GallerySyncSnapshot>) {
    if (!await this.options.repository.progress(lease, patch, this.now())) {
      this.controller?.abort();
      throw new GallerySyncError("conflict");
    }
  }
  private async runNext() {
    const lease = await this.options.repository.claim(this.now());
    if (!lease) return;
    if (this.closed) {
      await this.options.repository.finish(lease, { status: "failed", error: "interrupted" }, this.now());
      return;
    }
    this.active = lease;
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8 * 60_000);
    try {
      if (this.options.ownerIds && !this.options.ownerIds.includes(lease.ownerId)) throw new GallerySyncError("denied");
      const app = await this.definition(lease.appId);
      const selection = { ...lease.selection };
      await this.validate(lease.ownerId, app, selection, controller.signal);
      const checkpoint = await this.options.probe?.(lease.ownerId, selection, controller.signal);
      if (checkpoint && lease.checkpoint && lease.snapshot.lastCheckedAt && JSON.stringify(checkpoint) === JSON.stringify(lease.checkpoint)) {
        await this.options.repository.finish(lease, { status: "complete", stage: "finished", sources: lease.snapshot.sources.map(s => ({ ...s, status: "complete" })) }, this.now(), checkpoint);
        return;
      }
      if (lease.snapshot.lastCheckedAt) {
        const overlap = new Date(Date.parse(lease.snapshot.lastCheckedAt) - 86400000).toISOString().slice(0, 10);
        selection.start = overlap > selection.start ? overlap : selection.start;
        const today = this.now().toISOString().slice(0, 10);
        selection.end = selection.end > today ? selection.end : today;
      }
      let partial = false, skipped = 0;
      for (let i = 0; i < selection.accounts.length; i++) {
        controller.signal.throwIfAborted();
        const inventory = await this.validate(lease.ownerId, app, selection, controller.signal);
        const account = selection.accounts[i]!;
        const sources = lease.snapshot.sources.map((s, index) => index === i ? { ...s, status: "running" as const } : s);
        await this.progress(lease, { stage: "reading", sources });
        const single = { ...selection, accounts: [account], context: importContextLabel([account.service]) ? selection.context : "" };
        const prompt = importPrompt({ ...app, services: app.services.filter(s => s.id === account.service) }, single,
          inventory.map(a => ({ id: a.connectionId, service: a.service, account_label: a.label, account_email: a.email ?? null, status: "active" })));
        let result: z.infer<typeof CompletionSchema> | undefined;
        let failed = false;
        await this.options.dispatch(`${prompt}\nThis is a tracked app import, not a chat or approval request. Work within at most 30 source reads and 1000 records; report partial coverage if capped. Do not edit app/system files or create schedules. On records actually inserted or changed by this run, include importRunId: ${JSON.stringify(lease.snapshot.runId)} in the payload. Do not write unchanged records just to set this marker. Preserve manual edits, unknown facts and evidence as specified above. Finish with ONLY a JSON object {"galleryImport":"complete"|"partial"|"blocked","skipped":nonnegativeInteger}. Use complete only if all bounded source pages and relevant details were read and all intended app writes were verified; zero matches is valid. If any read, page, write, conflict or permission is unresolved use partial or blocked. Never request a second approval for these authorized read-only imports.`,
          undefined, async event => {
            controller.signal.throwIfAborted();
            if (event.type === "tool_end") await this.progress(lease, { steps: Math.min(1_000_000, lease.snapshot.steps + 1) });
            if (event.type === "aborted" || event.type === "refusal") failed = true;
            if (event.type === "result") {
              if (event.data.errors?.length) failed = true;
              try { result = CompletionSchema.parse(JSON.parse(event.data.result ?? "")); }
              catch (error) { console.warn("[gallery-sync] Import completion unavailable", error instanceof Error ? error.name : "UnknownError"); }
            }
          }, { senderId: lease.ownerId }, controller, { fundedRequestClass: lease.snapshot.lastCheckedAt ? "background" : "interactive" });
        controller.signal.throwIfAborted();
        if (failed || !result || result.galleryImport === "blocked") throw new GallerySyncError("invalid");
        partial ||= result.galleryImport === "partial";
        skipped += result.skipped;
        await this.progress(lease, { sources: lease.snapshot.sources.map((s, index) => index === i ? { ...s, status: result!.galleryImport === "partial" ? "partial" : "complete" } : s), skipped });
      }
      await this.progress(lease, { stage: "verifying" });
      const counts = await this.options.records(lease.appId, lease.snapshot.runId, new Date(lease.snapshot.startedAt!));
      await this.options.repository.finish(lease, { ...counts, status: partial ? "partial" : "complete", stage: "finished", error: null }, this.now(), checkpoint);
    } catch (error) {
      console.warn("[gallery-sync] Import stopped", error instanceof Error ? error.name : "UnknownError");
      if (!(error instanceof GallerySyncError && error.code === "conflict")) {
        try {
          await this.options.repository.finish(lease, { status: "failed", error: controller.signal.aborted ? "interrupted" : error instanceof GallerySyncError && error.code === "denied" ? "connection_changed" : error instanceof GallerySyncError && error.code === "invalid" ? "import_incomplete" : "unavailable",
            sources: lease.snapshot.sources.map(s => s.status === "running" ? { ...s, status: "failed" } : s) }, this.now());
        } catch (failure) { if (!(failure instanceof GallerySyncError && failure.code === "conflict")) throw failure; }
      }
    } finally { clearTimeout(timeout); this.controller = undefined; this.active = undefined; }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("App sync shutdown timed out")), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
