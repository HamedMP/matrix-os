import {
  canonicalChatApprovals, canonicalChatInputs, canonicalChatToolActivities, CanonicalChatResourceReferenceSchema, SafeAssistantPreviewSourceTextSchema,
  type CanonicalChatDetailResponse, type CanonicalChatApprovalView, type CanonicalChatInputView,
  type CanonicalToolActivity,
} from "@matrix-os/contracts";
import { boundedAoedeText } from "./presentation.js";

export interface AoedeCanonicalProjection {
  captions: { utterance?: string; response?: string; provisional?: boolean };
  approvals: CanonicalChatApprovalView[];
  inputs: CanonicalChatInputView[];
  progress: Array<Pick<CanonicalToolActivity, "id" | "kind" | "state" | "label" | "subagent">>;
  artifacts: Array<{ id: string; label: string; path: string }>;
  runId: string | null;
  outcome: "completed" | "failed" | "aborted" | null;
  canCancel: boolean;
}
export function safeAoedeArtifactPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024 || /[%?#:\\\x00-\x1f]/.test(value)) return null;
  const parsed = CanonicalChatResourceReferenceSchema.shape.path.unwrap().safeParse(value);
  if (!parsed.success || value.split("/").some(segment => segment.startsWith("."))
    || /(?:^|\/)(?:credentials?|secrets?|tokens?|id_(?:rsa|dsa|ecdsa|ed25519)|config\.json)(?:[._-]|\/|$)/i.test(value)
    || /\.(?:pem|p12|pfx|key)$/i.test(value)
    || /^(?:system|memory|agents)\//.test(value)) return null;
  return parsed.data;
}
function safeDescription(value: string | undefined): string {
  if (!value) return "";
  return SafeAssistantPreviewSourceTextSchema.safeParse(value).success ? boundedAoedeText(value) : "Details withheld for privacy.";
}
export function projectAoedeCanonical(detail: CanonicalChatDetailResponse | null): AoedeCanonicalProjection {
  const empty: AoedeCanonicalProjection = { captions: {}, approvals: [], inputs: [], progress: [], artifacts: [], runId: null, outcome: null, canCancel: false };
  if (!detail) return empty;
  const run = detail.runs.find(item => item.id === detail.record.activeRun?.runId) ?? detail.runs.at(-1);
  const user = [...detail.messages].reverse().find(item => item.role === "user");
  const response = [...detail.messages].reverse().find(item => item.role === "assistant" && (!user || (item.seq ?? 0) > (user.seq ?? 0)));
  const caption = (message: typeof user) => boundedAoedeText(message?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"));
  const artifacts: AoedeCanonicalProjection["artifacts"] = [];
  for (const message of detail.messages.slice(-200)) {
    if (message.role !== "assistant" || message.runId !== run?.id) continue;
    for (const part of message.parts) {
      if (part.type !== "resource_reference" || part.resource.kind !== "file") continue;
      const path = safeAoedeArtifactPath(part.resource.path);
      if (path && !artifacts.some(item => item.path === path) && artifacts.length < 32) artifacts.push({ id: part.resource.id, path, label: boundedAoedeText(part.resource.label, 160) });
    }
  }
  // Activity helpers own deduplication. Never render raw previews, tool output or arguments.
  const progress = run ? canonicalChatToolActivities(run, detail.activities.slice(-500)).slice(-32).map(({ id, kind, state, label, subagent }) => ({ id, kind, state, label: boundedAoedeText(label, 240), ...(subagent ? { subagent } : {}) })) : [];
  const approvals = canonicalChatApprovals(detail).slice(-32).map(approval => {
    const activity = [...detail.activities].reverse().find(item => item.type === "approval.requested" && item.runId === approval.runId && item.approvalId === approval.approvalId);
    return { ...approval,
      // Only canonical safeDescription is approved for standalone preview.
      description: safeDescription(activity?.type === "approval.requested" ? activity.safeDescription : undefined),
      title: safeDescription(activity?.type === "approval.requested" ? activity.title : approval.title),
      ...(activity?.type === "approval.requested" ? { argumentDigest: activity.argumentDigest } : {}),
    };
  });
  const terminal = run && ["completed", "failed", "aborted"].includes(run.status);
  const cancellation = run?.capabilitySnapshot.cancellation;
  return { captions: { ...(caption(user) ? { utterance: caption(user) } : {}), ...(caption(response) ? { response: caption(response) } : {}) },
    approvals, inputs: canonicalChatInputs(detail).slice(-32), progress, artifacts,
    runId: run?.id ?? null, outcome: terminal ? run!.status as AoedeCanonicalProjection["outcome"] : null,
    canCancel: Boolean(run && !terminal && (cancellation === true || cancellation === "run")),
  };
}
