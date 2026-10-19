import type { RuntimeCredentials } from './credentials.js';

/** Private control-process environment; never a container image/start variable. */
export function runtimeExecutionEnvironment(credentials:RuntimeCredentials):Record<string,string> {
  const base={HOME:'/workspace/home',MATRIX_HOME:'/workspace/home',NODE_ENV:'production',
    MATRIX_AUTH_TOKEN:credentials.authToken,DATABASE_URL:credentials.databaseUrl,CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1'};
  const authority=credentials.matrixGateway;
  if (authority) return {...base,RUNTIME_INFERENCE_MODE:'matrix-gateway',MATRIX_WORKSPACE_OWNER_ID:credentials.ownerId,
    MATRIX_WORKSPACE_GENERATION:String(credentials.generation),MATRIX_USER_ID:credentials.ownerId,MATRIX_CLERK_USER_ID:credentials.ownerId,
    MATRIX_HANDLE:authority.handle,MATRIX_MACHINE_ID:authority.machineId,MATRIX_RUNTIME_SLOT:authority.runtimeSlot,
    MATRIX_FUNDED_AI_ENABLED:'1',MATRIX_FUNDED_AI_PLATFORM_URL:authority.platformOrigin,MATRIX_FUNDED_AI_RELAY_URL:authority.relayOrigin,
    MATRIX_FUNDED_AI_RUNTIME_TOKEN:authority.runtimeToken,MATRIX_FUNDED_AI_RUN_TIMEOUT_MS:String(authority.maxRunMs)};
  if (!credentials.inferenceKey) throw new Error('Runtime credentials unavailable');
  return {...base,ANTHROPIC_API_KEY:credentials.inferenceKey};
}
