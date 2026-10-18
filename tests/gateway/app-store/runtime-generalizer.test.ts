import { it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { MATRIX_DEFAULT_MODEL_ID, buildBundledModelCatalog } from '../../../packages/gateway/src/ai-providers/model-catalog.js';
const mocks=vi.hoisted(()=>({publish:vi.fn((options:any)=>({generalizerStatus:()=>options.generalizer?.status()??{available:false},recover:async()=>{},close:async()=>{}}))}));
vi.mock('../../../packages/gateway/src/app-store/publish-service.js',()=>({createStorePublishService:mocks.publish}));
vi.mock('../../../packages/gateway/src/app-store/install-service.js',()=>({createStoreInstallService:()=>({recover:async()=>{},close:async()=>{}})}));
vi.mock('../../../packages/gateway/src/app-store/local-builder.js',()=>({createLocalStoreBuilder:()=>({close:async()=>{}})}));
vi.mock('../../../packages/gateway/src/app-store/submission-poller.js',()=>({createSubmissionPoller:()=>({start(){},close:async()=>{}})}));
vi.mock('../../../packages/gateway/src/bounded-json-file.js',()=>({readBoundedJsonFileWithIdentity:async()=>null}));
vi.mock('../../../packages/gateway/src/request-principal.js',async original=>({...await original<object>(),requireRequestPrincipal:()=>({userId:'owner'})}));
vi.mock('../../../packages/gateway/src/app-store/platform-client.js',async original=>({...await original<object>(),createAppStorePlatformClient:()=>({status:async()=>({enabled:true,reviewer:false,signingKeys:[]})})}));
import { startAppStoreRuntime } from '../../../packages/gateway/src/app-store/runtime.js';
it('wires trusted canonical reader, funding and admission into the owner publishing route at startup',async()=>{
  const app=new Hono();const getCredential=vi.fn();const fetchImpl=vi.fn();
  const providerSnapshotReader={getSnapshot:vi.fn(async()=>({instances:[],active:{providerInstanceId:null,accessSourceId:null,modelId:null},models:buildBundledModelCatalog(),accessSources:[{id:'matrix_cloudflare',vendor:'cloudflare',fundingKind:'matrix_included',state:'ready',checkedAt:new Date().toISOString(),staleAfter:new Date(Date.now()+60_000).toISOString(),eligibleModelIds:[MATRIX_DEFAULT_MODEL_ID]}]} as never))};
  const runtime=await startAppStoreRuntime(app,{homePath:'/owner',ownerIds:['owner'],platformUrl:'https://platform.example.test',token:'fixture',handle:'owner',providerSnapshotReader,fundedCredentialProvider:{enabled:true,getCredential} as never,fundedAdmission:{run:vi.fn(),close:vi.fn()},fetchImpl});
  try{const response=await app.request('/api/app-store/status');expect(response.status).toBe(200);expect(await response.json()).toMatchObject({enabled:true,signingKeys:[],generalizer:{available:true,label:expect.stringContaining('Matrix AI Gateway')}});expect(getCredential).not.toHaveBeenCalled();expect(fetchImpl).not.toHaveBeenCalled();}finally{await runtime.close();}
});
