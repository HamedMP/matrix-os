/**
 * Connector sources: the four kind handlers (Linear, Google Drive, Google Calendar, Slack bridge). Each parses and
 * bounds its config, names the source without a network call, stores the config in brain_connector_sources, builds
 * a fresh adapter per run and reports availability without provider content. Credentials never enter a config.
 */
import { z } from "zod/v4";
import {
  BRAIN_SOURCE_CONFIG_LIMITS as LIMITS, BrainFeatureError, type BrainConnectableSourceKind,
  type BrainGoogleCalendarSourceConfig, type BrainGoogleDriveSourceConfig, type BrainIntegrationService,
  type BrainLinearSourceConfig, type BrainSlackBridgeSourceConfig, type BrainSourceAdapter,
  type BrainSourceConfigView, type BrainSourceKindAvailability, type BrainSourceKindHandler,
} from "../../contracts.js";
import { BRAIN_SOURCE_LABEL_MAX_CHARS } from "../../types.js";
import { loadConnectorConfig, saveConnectorConfig } from "./database.js";
import { createGoogleCalendarAdapter } from "./google-calendar.js";
import { createGoogleDriveAdapter } from "./google-drive.js";
import { createLinearAdapter } from "./linear.js";
import type { ProviderCall } from "./provider.js";
import { createSlackBridgeAdapter } from "./slack-bridge.js";
import { clampTitle, shortHash } from "./text.js";
import {
  BRAIN_CONNECTOR_LIMITS, type BrainConnectorHandlerDeps, type BrainConnectorKind, type BrainSlackBridgeHandlerDeps,
} from "./types.js";

const safeText = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u);
const accountLabel = safeText(LIMITS.listItemMaxChars).optional();
function uniqueList<T extends z.ZodType<string>>(item: T, min: number, max: number) {
  return z.array(item).min(min).max(max).refine((values) => new Set(values).size === values.length);
}

export const LinearConfigSchema = z.object({
  teamKeys: uniqueList(z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/), 1, LIMITS.linearTeams),
  accountLabel,
  include: z.object({
    issues: z.boolean().default(true), comments: z.boolean().default(true), projectUpdates: z.boolean().default(true),
  }).strict().default({ issues: true, comments: true, projectUpdates: true })
    .refine((include) => include.issues || include.comments || include.projectUpdates),
}).strict();
export const GoogleDriveConfigSchema = z.object({
  folderIds: uniqueList(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), 1, LIMITS.driveFolders),
  accountLabel,
}).strict();
export const GoogleCalendarConfigSchema = z.object({
  // No whitespace or control characters, and never "." or "..": the id becomes one URL path segment.
  calendarIds: uniqueList(z.string().max(LIMITS.listItemMaxChars).regex(/^(?!\.{1,2}$)[^\s\p{Cc}]+$/u), 1, LIMITS.calendars),
  accountLabel,
  includeEventBodies: z.boolean().default(false),
  pastDays: z.number().int().min(0).max(LIMITS.calendarPastDaysMax).default(30),
  futureDays: z.number().int().min(0).max(LIMITS.calendarFutureDaysMax).default(30),
}).strict();
export const SlackBridgeConfigSchema = z.object({
  companyScopeId: z.uuid(),
  /** Empty: every approved company channel the Company Brain captured. Direct messages are never captured there. */
  channelIds: uniqueList(z.string().regex(/^[CG][A-Z0-9]{2,63}$/), 0, LIMITS.slackChannels).default([]),
}).strict();

interface HandlerSpec<TConfig> {
  readonly kind: BrainConnectorKind & BrainConnectableSourceKind;
  /** May this run use the config's account (its pinned label still connected, or the only account)? */
  account?(ownerId: string, config: TConfig): Promise<boolean>;
  readonly schema: z.ZodType<TConfig>;
  name(config: TConfig): { readonly identity: readonly string[]; readonly label: string };
  view(config: TConfig): BrainSourceConfigView;
  adapter(ownerId: string, config: TConfig): BrainSourceAdapter<TConfig> | null;
  availability(ownerId: string): Promise<BrainSourceKindAvailability>;
}

function parseWith<TConfig>(schema: z.ZodType<TConfig>, raw: unknown): TConfig {
  const parsed = schema.safeParse(raw);
  // Every schema bounds its lists and strings below LIMITS.configMaxBytes; saveConnectorConfig re-checks the bytes.
  if (!parsed.success) throw new BrainFeatureError("source_config_invalid", { cause: parsed.error });
  return parsed.data;
}

function buildHandler<TConfig extends object>(
  spec: HandlerSpec<TConfig>, deps: { readonly kysely: BrainConnectorHandlerDeps["kysely"] },
): BrainSourceKindHandler<TConfig> {
  return {
    kind: spec.kind,
    parseConfig: (raw) => parseWith(spec.schema, raw),
    identify(_project, config) {
      const named = spec.name(config);
      return {
        externalRef: `${spec.kind}:${shortHash(named.identity, 40)}`,
        label: clampTitle(named.label, spec.kind, BRAIN_SOURCE_LABEL_MAX_CHARS),
      };
    },
    saveConfig: (scope, sourceId, config, db = deps.kysely) => saveConnectorConfig(db, spec.kind, scope, sourceId, config),
    async loadConfig(scope, sourceId) {
      const stored = await loadConnectorConfig(deps.kysely, spec.kind, scope, sourceId);
      return stored === null ? null : parseWith(spec.schema, stored);
    },
    async createAdapter(ownerId, _project, config) {
      // Building an adapter is local and cheap; the account check decides whether it may run.
      const adapter = spec.adapter(ownerId, config);
      if (adapter === null || !(await spec.availability(ownerId)).available
        || (spec.account !== undefined && !await spec.account(ownerId, config))) return { ok: false, code: "not_connected" };
      return { ok: true, adapter };
    },
    viewConfig: (config) => spec.view(config),
    availability: (ownerId) => spec.availability(ownerId),
  };
}

function integrationAvailability(deps: BrainConnectorHandlerDeps, service: BrainIntegrationService) {
  return async (ownerId: string): Promise<BrainSourceKindAvailability> => {
    // No transport: connecting an account in Settings would not help, so never say not_connected.
    if (deps.isConnected === undefined || deps.isConfigured?.() === false) {
      return { available: false, reason: "not_configured" };
    }
    return await deps.isConnected(ownerId, service) ? { available: true } : { available: false, reason: "not_connected" };
  };
}

/** A run uses exactly its pinned account; with none pinned, only the owner's single account (never "the first"). */
function accountCheck(deps: BrainConnectorHandlerDeps, service: BrainIntegrationService) {
  return async (ownerId: string, config: { readonly accountLabel?: string }): Promise<boolean> => {
    if (deps.accounts === undefined) return true;
    const labels = await deps.accounts(ownerId, service);
    return config.accountLabel === undefined ? labels.length === 1 : labels.includes(config.accountLabel);
  };
}

/** Account label and sorted ids: the same selection always names the same source. */
function selection(label: string | undefined, ids: readonly string[]): string[] {
  return [label ?? "", ...[...ids].sort()];
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function timeoutOf(deps: { readonly providerTimeoutMs?: number }): number {
  const value = deps.providerTimeoutMs ?? BRAIN_CONNECTOR_LIMITS.providerTimeoutMs;
  return Math.min(30_000, Math.max(1_000, Math.floor(value)));
}

function callOf(deps: BrainConnectorHandlerDeps, ownerId: string): ProviderCall {
  return { integrations: deps.integrations, timeoutMs: timeoutOf(deps), ownerId };
}

export function createBrainLinearHandler(deps: BrainConnectorHandlerDeps): BrainSourceKindHandler<BrainLinearSourceConfig> {
  return buildHandler<BrainLinearSourceConfig>({
    kind: "linear", schema: LinearConfigSchema,
    name: (config) => ({ identity: selection(config.accountLabel, config.teamKeys), label: `Linear ${config.teamKeys.join(", ")}` }),
    view: (config) => ({
      teamKeys: [...config.teamKeys], accountLabel: config.accountLabel ?? null, issues: config.include.issues,
      comments: config.include.comments, projectUpdates: config.include.projectUpdates,
    }),
    adapter: (ownerId) => createLinearAdapter(callOf(deps, ownerId)),
    availability: integrationAvailability(deps, "linear"), account: accountCheck(deps, "linear"),
  }, deps);
}

export function createBrainGoogleDriveHandler(
  deps: BrainConnectorHandlerDeps,
): BrainSourceKindHandler<BrainGoogleDriveSourceConfig> {
  return buildHandler<BrainGoogleDriveSourceConfig>({
    kind: "google_drive", schema: GoogleDriveConfigSchema,
    name: (config) => ({
      identity: selection(config.accountLabel, config.folderIds),
      label: `Google Drive (${counted(config.folderIds.length, "folder")})`,
    }),
    view: (config) => ({ folderIds: [...config.folderIds], accountLabel: config.accountLabel ?? null }),
    adapter: (ownerId, config) => createGoogleDriveAdapter(callOf(deps, ownerId), config),
    availability: integrationAvailability(deps, "google_drive"), account: accountCheck(deps, "google_drive"),
  }, deps);
}

export function createBrainGoogleCalendarHandler(
  deps: BrainConnectorHandlerDeps,
): BrainSourceKindHandler<BrainGoogleCalendarSourceConfig> {
  return buildHandler<BrainGoogleCalendarSourceConfig>({
    kind: "google_calendar", schema: GoogleCalendarConfigSchema,
    name: (config) => ({
      identity: selection(config.accountLabel, config.calendarIds),
      label: `Google Calendar (${counted(config.calendarIds.length, "calendar")})`,
    }),
    view: (config) => ({
      calendarIds: [...config.calendarIds], accountLabel: config.accountLabel ?? null,
      includeEventBodies: config.includeEventBodies, pastDays: config.pastDays, futureDays: config.futureDays,
    }),
    adapter: (ownerId, config) => createGoogleCalendarAdapter(callOf(deps, ownerId), config),
    availability: integrationAvailability(deps, "google_calendar"), account: accountCheck(deps, "google_calendar"),
  }, deps);
}

export function createBrainSlackBridgeHandler(
  deps: BrainSlackBridgeHandlerDeps,
): BrainSourceKindHandler<BrainSlackBridgeSourceConfig> {
  const capture = deps.capture;
  return buildHandler<BrainSlackBridgeSourceConfig>({
    kind: "slack_bridge", schema: SlackBridgeConfigSchema,
    name: (config) => ({ identity: [config.companyScopeId], label: "Slack threads" }),
    view: (config) => ({ companyScopeId: config.companyScopeId, channelIds: [...config.channelIds] }),
    adapter: (ownerId, config) => capture === undefined ? null : createSlackBridgeAdapter(capture, ownerId, timeoutOf(deps), config),
    availability: async () => capture === undefined ? { available: false, reason: "not_configured" } : { available: true },
  }, deps);
}
