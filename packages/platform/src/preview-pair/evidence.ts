import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairShaSchema, 
  parseLivePreviewPairManifest, type PreviewPairManifest } from "@matrix-os/contracts/preview-pair";
import { PreviewPairReportSelectionSchema } from "@matrix-os/contracts/preview-pair-control";
export const PREVIEW_QUALIFICATION_SCENARIOS = {
  creation_opt_in: { role: "owner", steps: ["create_private_project", "creation_opt_in", "sharing_dialog", "explicit_publish", "shared_indicator"] },
  first_later_share: { role: "owner", steps: ["create_private_project", "first_share_click", "preflight", "scope_created", "scope_read", "default_grant", "inventory_complete", "sharing_dialog", "explicit_publish"] },
  member_activation: { role: "member", steps: ["discovery", "accept_invitation", "open_project"] },
  inherited_prompt_reopen: { role: "member", steps: ["open_inherited_chat", "send_prompt", "response_persisted", "reopen_chat"] },
  outsider_denial: { role: "outsider", steps: ["discovery_denied", "open_denied", "prompt_denied", "no_owner_execution"] },
  owner_restart: { role: "owner", steps: ["owner_stopped", "owner_restarted", "fresh_control", "member_reopen"] },
  failed_publication: { role: "owner", steps: ["new_private_project", "publish_failed", "scope_private", "no_directory_entry", "no_access_widened"] },
  cleanup: { role: "owner", steps: ["stop_requested", "access_retired", "owner_absent", "member_absent", "lease_released"] },
} as const;
const scenarios = Object.keys(PREVIEW_QUALIFICATION_SCENARIOS) as [keyof typeof PREVIEW_QUALIFICATION_SCENARIOS, ...Array<keyof typeof PREVIEW_QUALIFICATION_SCENARIOS>];
const Result = z.enum(["pass", "fail", "not_run"]);
const Capture = z.strictObject({ kind: z.enum(["screenshot", "recording"]), url: z.url().max(2048).refine(raw => {
  const url = new URL(raw); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "Use a clean HTTPS capture link without credentials or signed query parameters") });
export const PreviewQualificationObservationSchema = z.strictObject({ scenario: z.enum(scenarios),
  surface: z.enum(["web_desktop", "electron_desktop"]), boundary: z.enum(["live", "fixture"]),
  role: z.enum(["owner", "member", "outsider"]), result: Result, observedAt: z.iso.datetime({ offset: true }),
  steps: z.array(z.strictObject({ step: z.string().min(1).max(64), result: Result })).max(16), captures: z.array(Capture).max(4) })
  .superRefine((row, ctx) => {
    const required = PREVIEW_QUALIFICATION_SCENARIOS[row.scenario];
    const allowed = new Set<string>(required.steps); // <=9 immutable keys, discarded per observation.
    const seen = new Set<string>(); // <=16 input entries, discarded per observation.
    if (row.role !== required.role) ctx.addIssue({ code: "custom", message: "Wrong scenario role" });
    for (const step of row.steps) {
      if (!allowed.has(step.step) || seen.has(step.step)) ctx.addIssue({ code: "custom", message: "Invalid scenario step" });
      seen.add(step.step);
    }
    if (row.result === "not_run" && row.steps.length || row.result === "fail" && !row.steps.some(step => step.result === "fail")) ctx.addIssue({ code: "custom", message: "Result has no matching observation" });
    if (row.result === "pass" && (seen.size !== allowed.size || row.steps.some(step => step.result !== "pass"))) ctx.addIssue({ code: "custom", message: "Incomplete scenario pass" });
    if (row.result === "pass" && row.boundary === "live" && (!row.captures.some(capture => capture.kind === "screenshot") || !row.captures.some(capture => capture.kind === "recording"))) ctx.addIssue({ code: "custom", message: "Live pass needs both visual captures" });
  });
export const PreviewQualificationInputSchema = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  sourceSha: PreviewPairShaSchema, observations: z.array(PreviewQualificationObservationSchema).max(16) });
/** An owner-controlled export of human observations. It grants no access, writes
 * no platform state, and cannot promote infrastructure/fixture checks to acceptance.
 * The caller obtains manifest/current directly from its fixed authenticated Source. */
export function createPreviewQualification(options: { manifest: PreviewPairManifest; current: unknown;
  input: unknown; startedAt: number; now: number }) {
  const manifest = parseLivePreviewPairManifest(options.manifest, options.startedAt), current = PreviewPairReportSelectionSchema.parse(options.current), input = PreviewQualificationInputSchema.parse(options.input);
  if (!Number.isFinite(options.now) || options.now < options.startedAt || current.pairId !== manifest.pairId || current.generation !== manifest.generation
    || current.sourceSha !== manifest.sourceSha || current.pr !== manifest.pr || input.pairId !== manifest.pairId || input.generation !== manifest.generation || input.sourceSha !== manifest.sourceSha) throw new Error("Preview qualification source changed");
  const unique = new Set<string>(); // <=16 observations, discarded after export.
  for (const row of input.observations) {
    const key = row.surface + ":" + row.scenario, time = Date.parse(row.observedAt);
    if (unique.has(key) || time < options.startedAt - 5000 || time > options.now + 5000) throw new Error("Preview qualification observation is unavailable");
    unique.add(key);
  }
  const liveReportedPasses = input.observations.filter(row => row.boundary === "live" && row.result === "pass").length;
  return { schemaVersion: 1 as const, kind: "collaboration-preview-qualification" as const,
    startedAt: new Date(options.startedAt).toISOString(), finishedAt: new Date(options.now).toISOString(),
    provenance: { pairId: manifest.pairId, generation: manifest.generation, pr: manifest.pr, sourceSha: manifest.sourceSha,
      platformSource: manifest.platformSource, desktopArtifacts: manifest.desktopArtifacts,
      runtimeBuilds: Object.values(manifest.members).map(member => ({ role: member.role, installedVersion: member.installedVersion,
        runningVersion: member.runningVersion, installedSha: member.installedSha, runningSha: member.runningSha })) },
    currentState: current.state, observations: input.observations,
    summary: { required: 16, liveReportedPasses, fixtureReportedPasses: input.observations.filter(row => row.boundary === "fixture" && row.result === "pass").length,
      failed: input.observations.filter(row => row.result === "fail").length, pending: 16 - liveReportedPasses, requiresReview: true as const } };
}
