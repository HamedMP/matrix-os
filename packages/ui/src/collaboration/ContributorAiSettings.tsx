import {
  CollaborationExecutionPolicyOptionsSchema,
  CollaborationExecutionPolicySchema,
  type CollaborationExecutionPolicyOption,
  type CollaborationExecutionPolicyOptions,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useEffect, useMemo, useState } from "react";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const controlClass = "rounded-lg border bg-transparent px-3 py-2 text-sm disabled:opacity-50";

export function ContributorAiSettings({ api, scope }: {
  api: CollaborationApi;
  scope: CollaborationScope;
}) {
  const executionScopeId = scope.kind === "chat" && scope.membershipMode === "inherited"
    ? scope.parentScopeId
    : scope.id;
  const [state, setState] = useState<CollaborationExecutionPolicyOptions | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (scope.role !== "owner" || !executionScopeId || !["project", "chat"].includes(scope.kind)) return;
    let active = true;
    setState(null);
    setError("");
    setFeedback("");
    setAcknowledged(false);
    void api.get(`/api/collaboration/scopes/${encodeURIComponent(executionScopeId)}/execution-policy/options`)
      .then((value) => {
        const parsed = CollaborationExecutionPolicyOptionsSchema.parse(value);
        if (!active) return;
        setState(parsed);
        const selected = optionForPolicy(parsed) ?? parsed.options.find((option) => option.available) ?? parsed.options[0];
        if (selected) {
          setSourceKey(optionKey(selected));
          setModelId(parsed.policy?.allowedModelIds.find((id) => selected.modelIds.includes(id))
            ?? selected.defaultModelId ?? selected.modelIds[0] ?? "");
        }
      })
      .catch((failure: unknown) => {
        console.warn("[collaboration-access] contributor AI options unavailable",
          failure instanceof Error ? failure.name : "UnknownError");
        if (active) setError("Contributor AI settings are unavailable. Try again.");
      });
    return () => { active = false; };
  }, [api, executionScopeId, scope.kind, scope.role]);

  const selected = useMemo(() => state?.options.find(
    (option) => optionKey(option) === sourceKey,
  ) ?? null, [sourceKey, state]);
  const enabled = state?.policy?.effectiveSubmitMode === "members";
  if (scope.role !== "owner" || !executionScopeId || !["project", "chat"].includes(scope.kind)) return null;

  const save = async () => {
    if (!state || !api.put) return;
    const option = selected ?? optionForPolicy(state);
    const policy = state.policy;
    if (!option?.source || !modelId) return;
    setPending(true);
    setError("");
    setFeedback("");
    try {
      const updated = CollaborationExecutionPolicySchema.parse(await api.put(
        `/api/collaboration/scopes/${encodeURIComponent(executionScopeId)}/execution-policy`,
        {
          clientRequestId: crypto.randomUUID(),
          expectedRevision: policy?.revision ?? "0",
          accessSourceId: option.source.accessSourceId,
          providerInstanceId: option.source.providerInstanceId,
          submitMode: "follow_organization",
          acknowledgeProviderTerms: true,
          allowedModelIds: [modelId],
        },
      ));
      setState({ ...state, policy: updated });
      setAcknowledged(false);
      setFeedback(updated.effectiveSubmitMode === "members"
        ? "Contributors can now send prompts using this owner-selected AI source."
        : "Contributor AI requests are disabled.");
    } catch (failure: unknown) {
      console.warn("[collaboration-access] contributor AI update failed",
        failure instanceof Error ? failure.name : "UnknownError");
      setError("Contributor AI settings could not be updated. Refresh and try again.");
    } finally {
      setPending(false);
    }
  };

  return <section aria-label="Contributor AI" className="rounded-xl border p-4 text-sm">
    <h3 className="font-medium">Contributor AI</h3>
    {state === null ? error ? <p role="alert" className="mt-2">{error}</p>
      : <p className="mt-2">Loading owner AI sources…</p> : enabled ? <>
      <p className="mt-2">
        Contributors can send prompts using the owner's selected source and allowed model.
        To prevent a collaborator from prompting, change their access to Viewer.
      </p>
    </> : state.options.length === 0 ? <p className="mt-2">
      Set up a supported owner AI account in Agents &amp; providers before enabling contributor prompts.
    </p> : <>
      <p className="mt-2">Choose the owner-funded source and model that contributor prompts may use.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">Owner AI source
          <select className={controlClass} value={sourceKey} onChange={(event) => {
            const option = state.options.find((candidate) => optionKey(candidate) === event.target.value);
            setSourceKey(event.target.value);
            setModelId(option?.defaultModelId ?? option?.modelIds[0] ?? "");
          }}>
            {state.options.map((option) => <option key={optionKey(option)}
              value={optionKey(option)} disabled={!option.available}>
              {option.sourceLabel}{option.available ? "" : " (unavailable)"}
            </option>)}
          </select>
        </label>
        <label className="grid gap-1">Allowed model
          <select className={controlClass} value={modelId}
            onChange={(event) => setModelId(event.target.value)}>
            {(selected?.modelIds ?? []).map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-3 flex items-start gap-2">
        <input type="checkbox" checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>I understand contributor prompts use my selected provider account and may incur charges under that provider's terms.</span>
      </label>
      <button type="button" className={`${controlClass} mt-3`}
        disabled={pending || !api.put || !acknowledged || !selected?.available || !modelId}
        onClick={() => void save()}>
        {pending ? "Saving…" : "Use this AI source for contributors"}
      </button>
    </>}
    {feedback ? <p role="status" className="mt-2">{feedback}</p> : null}
    {state !== null && error ? <p role="alert" className="mt-2">{error}</p> : null}
  </section>;
}

function optionForPolicy(state: CollaborationExecutionPolicyOptions): CollaborationExecutionPolicyOption | undefined {
  return state.policy ? state.options.find((option) =>
    option.source.accessSourceId === state.policy!.source.accessSourceId
      && option.source.providerInstanceId === state.policy!.source.providerInstanceId) : undefined;
}

function optionKey(option: CollaborationExecutionPolicyOption): string {
  return JSON.stringify([option.source.accessSourceId, option.source.providerInstanceId]);
}
