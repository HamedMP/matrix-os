import { afterEach, describe, expect, it, vi } from "vitest";
const f=vi.hoisted(()=>({store:{migrate:vi.fn(),expire:vi.fn(),getOwnerPolicy:vi.fn(),configureOwner:vi.fn(),aggregate:vi.fn()},
  classifier:{capture:vi.fn(),completed:vi.fn(),cancel:vi.fn(),close:vi.fn(),cancelOwner:vi.fn(),deleteOwner:vi.fn(),deleteChat:vi.fn(),whenIdle:vi.fn()},
  transport:vi.fn(),createStore:vi.fn(),createClassifier:vi.fn()}));
vi.mock("../../packages/gateway/src/chat-analytics/index.js",()=>({createChatAnalyticsStore:f.createStore,createTransientChatClassifier:f.createClassifier}));
vi.mock("../../packages/gateway/src/chat-usage-classifier-transport.js",()=>({CHAT_USAGE_CLASSIFIER_MODEL:"@cf/openai/gpt-oss-20b",createFundedChatUsageTransport:f.transport}));
import { startChatUsageAnalytics } from "../../packages/gateway/src/startup/chat-usage.js";
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
function setup(){
  f.createStore.mockReturnValue(f.store);f.createClassifier.mockReturnValue(f.classifier);f.store.migrate.mockResolvedValue(undefined);f.store.expire.mockResolvedValue(0);f.classifier.close.mockResolvedValue({drained:true});f.transport.mockReturnValue(vi.fn());
  return{env:{MATRIX_CHAT_ANALYTICS_ENABLED:"true"},db:{} as never,ownerId:"owner_one",fundedConfig:{relayBaseUrl:"https://relay.example.test",identity:{ownerId:"owner_one"}} as never,fundedCredentialProvider:{enabled:true} as never};
}
describe("ordinary Chat analytics host lifecycle",()=>{
  it("defaults off before migrations, credentials or timers",async()=>{
    expect(await startChatUsageAnalytics({...setup(),env:{}})).toBeUndefined();expect(f.createStore).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
  });
  it("requires an exact configured owner and Matrix managed funding route",async()=>{
    for(const changed of [{db:null},{ownerId:null},{fundedCredentialProvider:undefined},{fundedConfig:undefined},{ownerId:"other"}]) await expect(startChatUsageAnalytics({...setup(),...changed})).rejects.toThrow("Chat usage unavailable");
    expect(f.createStore).not.toHaveBeenCalled();
  });
  it("migrates owner storage, wires real classifier and expires metadata on a recurring timer",async()=>{
    vi.useFakeTimers();const options=setup();const runtime=await startChatUsageAnalytics(options);
    expect(runtime?.store).toBe(f.store);expect(f.createStore).toHaveBeenCalledWith(options.db);expect(f.store.migrate).toHaveBeenCalledOnce();
    expect(f.createClassifier).toHaveBeenCalledWith(expect.objectContaining({enabled:true,store:f.store,classify:expect.any(Function)}));
    await vi.advanceTimersByTimeAsync(5*60_000);expect(f.store.expire).toHaveBeenCalledOnce();
    await runtime!.classifier.close();await vi.advanceTimersByTimeAsync(5*60_000);expect(f.store.expire).toHaveBeenCalledOnce();
    expect(f.classifier.close).toHaveBeenCalledOnce();
    expect(options.db).not.toHaveProperty("destroy");
  });
  it("reports an incomplete classifier drain honestly",async()=>{
    const runtime=await startChatUsageAnalytics(setup());f.classifier.close.mockResolvedValue({drained:false});
    expect(await runtime!.classifier.close()).toEqual({drained:false});
  });
  it("awaits an already-running retention transaction before reporting a complete drain",async()=>{
    vi.useFakeTimers();let finish!:()=>void;const held=new Promise<void>(resolve=>{finish=resolve;});
    const options=setup();f.store.expire.mockReturnValue(held as never);const runtime=await startChatUsageAnalytics(options);
    await vi.advanceTimersByTimeAsync(5*60_000);expect(f.store.expire).toHaveBeenCalledOnce();
    let closed=false;const closing=runtime!.classifier.close().then(result=>{closed=true;return result;});
    await vi.advanceTimersByTimeAsync(0);expect(closed).toBe(false);
    finish();expect(await closing).toEqual({drained:true});
  });
});
