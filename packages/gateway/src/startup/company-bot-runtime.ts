import type { CanonicalChatProviderAdapter } from "../chat/provider-adapter.js";
import type { CollaborationRunBinding } from "@matrix-os/contracts";
import type { CollaborationAuthority } from "../collaboration/authority.js";
import type { CollaborationExecutionPolicyRepository } from "../collaboration/execution-policy.js";
import type { SharedRunOwnerSource } from "../collaboration/shared-run-owner-source.js";
import type { SharedMatrixBotExtension } from "../collaboration/shared-matrix-bot.js";
import type { GroupBotAuthorizer } from "../bots/runtime-registry.js";
import type { GroupBotRunRequest } from "../bots/admission.js";
import type { createSharedBotModelRouteResolver } from "../bots/codex-route.js";
import { BotRouteError } from "../bots/route-resolver.js";

export interface CompanyCanonicalRun { scopeId:string;chatId:string;status:string;binding:CollaborationRunBinding }
export function createCompanyBotRuntime(options:{ownerId:string;modelId?:string;
  loadRun(runId:string):Promise<CompanyCanonicalRun|null>;
  authority:Pick<CollaborationAuthority,"authorize">;policies:Pick<CollaborationExecutionPolicyRepository,"resolve">;
  ownerSource:Pick<SharedRunOwnerSource,"prepare">;
  resolveModel:ReturnType<typeof createSharedBotModelRouteResolver>;
  getAdapter():CanonicalChatProviderAdapter|undefined;
}) {
  const denied=()=>new BotRouteError("model_unavailable");
  async function validated(input:{scopeId?:string;actorId?:string;ownerId?:string;chatId?:string;runId?:string}) {
    if(!input.runId || !input.chatId || input.ownerId!==options.ownerId)throw denied();
    const run=await options.loadRun(input.runId);
    if(!run || run.chatId!==input.chatId || (input.scopeId && run.scopeId!==input.scopeId)
      || !["accepted","running","waiting_for_approval","waiting_for_input"].includes(run.status)
      || run.binding.runId!==input.runId || run.binding.executingOwnerId!==options.ownerId
      || (input.actorId && run.binding.requestingActorId!==input.actorId)
      || !run.binding.executionRoot || !["project","worktree"].includes(run.binding.executionRoot.kind)
      || !/^[a-f0-9]{64}$/.test(run.binding.rootFingerprint)
      || !/^[1-9][0-9]{0,18}$/.test(String(run.binding.sessionGeneration)))throw denied();
    const context=await options.authority.authorize({scopeId:run.scopeId,actorId:run.binding.requestingActorId,action:"request_ai"});
    if(context.scopeId!==run.scopeId || context.actorId!==run.binding.requestingActorId || context.ownerId!==options.ownerId
      || context.resourceKind!=="chat" || context.resourceId!==run.chatId || !context.organizationId)throw denied();
    const policy=await options.policies.resolve(run.scopeId);
    const source=run.binding.source;
    if(!policy || policy.ownerId!==options.ownerId || policy.revision!==run.binding.policyRevision
      || policy.source.accessSourceId!==source.accessSourceId || policy.source.providerInstanceId!==source.providerInstanceId
      || policy.source.harness!==source.harness || !policy.allowedModelIds.includes(source.modelId))throw denied();
    const decision=await options.ownerSource.prepare({scopeId:run.scopeId,chatId:run.chatId,ownerId:options.ownerId,
      requestingActorId:run.binding.requestingActorId,driverKind:source.harness});
    if(decision.policyRevision!==run.binding.policyRevision || decision.providerInstanceId!==source.providerInstanceId
      || decision.harness!==source.harness || !decision.allowedModelIds.includes(source.modelId))throw denied();
    return {run,context,decision};
  }
  const authorizeGroup:GroupBotAuthorizer=async input=>(await validated(input)).context;
  async function resolveGroupRun(input:{ownerId:string;chatId:string;runId:string}):Promise<GroupBotRunRequest> {
    const {run}=await validated(input);
    return {scopeId:run.scopeId,actorId:run.binding.requestingActorId,
      sessionGeneration:String(run.binding.sessionGeneration),
      executionRoot:run.binding.executionRoot as GroupBotRunRequest["executionRoot"],executionRootFingerprint:run.binding.rootFingerprint};
  }
  async function resolveGroupRoute(input:{ownerId:string;chatId:string;runId:string;group:GroupBotRunRequest}) {
    const {run,decision}=await validated({...input,scopeId:input.group.scopeId,actorId:input.group.actorId});
    if(JSON.stringify(run.binding.executionRoot)!==JSON.stringify(input.group.executionRoot)
      || run.binding.rootFingerprint!==input.group.executionRootFingerprint)throw denied();
    return options.resolveModel(decision,run.binding.source.modelId);
  }
  const matrixBot:SharedMatrixBotExtension={
    async resolvePolicyDriver(_execution,_run,context) {
      const policy=await options.policies.resolve(context.scopeId);
      if(!policy || policy.ownerId!==options.ownerId)throw denied();
      return policy.source.harness;
    },
    async prepareAdapter(_execution,_run,context,decision) {
      const adapter=options.getAdapter();
      if(context.ownerId!==options.ownerId || !options.modelId || !adapter)throw denied();
      await options.resolveModel(decision,options.modelId);
      return {adapter,modelId:options.modelId};
    },
    async readiness(ownerId) {return ownerId===options.ownerId && options.modelId && options.getAdapter()?"ready":"unavailable";},
  };
  return {authorizeGroup,resolveGroupRun,resolveGroupRoute,matrixBot};
}
