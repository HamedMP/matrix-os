import {existsSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {_electron,type ElectronApplication,type Page} from "playwright";
import {startClaudeLegacyRecoveryGateway} from "./fixtures/claude-legacy-recovery";
import {createEvidenceDirectory} from "./fixtures/evidence-directory";
import {dismissGettingStartedOnInteraction} from "./fixtures/getting-started";
import {closeElectronApp} from "./fixtures/close-electron";
const root=resolve(__dirname,"../../..");
const built = existsSync(join(root,"desktop/out/main/index.js"));
if(process.env.MATRIX_DESKTOP_E2E_REQUIRED==="1"&&!built)throw new Error("Required Electron Desktop build is missing");
const suite = built ? describe : describe.skip;
suite("Electron Desktop native Claude legacy recovery (synthetic identity)",()=>{
 let app:ElectronApplication,page:Page,profile:string;
 let gateway:Awaited<ReturnType<typeof startClaudeLegacyRecoveryGateway>>;
 let captures:ReturnType<typeof createEvidenceDirectory>;
 const settings=()=>page.locator(".matrix-agents-providers");
 const row=()=>settings().locator(".matrix-ap-rail-item").filter({hasText:"Claude"}).first();
 beforeAll(async()=>{
  captures=createEvidenceDirectory(process.env.MATRIX_SETTINGS_EVIDENCE_DIR ? join(process.env.MATRIX_SETTINGS_EVIDENCE_DIR,"claude-legacy-connection") : undefined);
  gateway=await startClaudeLegacyRecoveryGateway();profile=mkdtempSync(join(tmpdir(),"matrix-2632-electron-"));
  app=await _electron.launch({executablePath:createRequire(join(root,"desktop/package.json"))("electron") as string,
    args:[join(root,"desktop/out/main/index.js")],env:{...process.env,OPERATOR_GATEWAY_URL:gateway.url,OPERATOR_USER_DATA_DIR:profile}});
  await app.evaluate(({shell})=>{shell.openExternal=async()=>{};});page=await app.firstWindow();
  await dismissGettingStartedOnInteraction(page);
  await page.getByRole("button",{name:/create account/i}).waitFor();
  await page.evaluate(()=>window.operator.invoke("auth:start-device-flow",{}));
  await page.getByRole("button",{name:"Terminal",exact:true}).first().waitFor({timeout:15000});
  await page.getByRole("button",{name:"Open account menu",exact:true}).click();
  await page.getByRole("menuitem",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:"Agents & providers",exact:true}).click();
  await row().waitFor();await row().click();
  const identity=await app.evaluate(({app})=>({appPath:app.getAppPath(),electron:process.versions.electron,chrome:process.versions.chrome}));
  writeFileSync(join(captures.path,"runtime.json"),JSON.stringify({...identity,backend:"isolated synthetic identity/store; real workflow adoption and routes",source:process.env.MATRIX_BUILD_SHA??"working-tree"},null,2));
 },60000);
 afterAll(async()=>{try{if(app)await closeElectronApp(app);}finally{try{await gateway?.close();}finally{if(profile)rmSync(profile,{recursive:true,force:true});captures?.cleanup();}}});
 it("shows connected native identity without silently adopting the old Matrix binding",async()=>{
  const adoption=settings().getByRole("button",{name:"Use connected Claude account",exact:true});
  await adoption.waitFor({timeout:15000});
  await settings().getByText("Not enabled for Bots",{exact:true}).waitFor();
  await adoption.scrollIntoViewIfNeeded();
  expect(await row().innerText()).toContain("Connected");
  expect(gateway.snapshot().harnesses[0]).toMatchObject({configuredAccessSourceId:"matrix_included",selectedAccountId:null,enabled:false,configuredEnabled:true});
  expect(gateway.counters()).toEqual({completions:0,browserStarts:0,terminalStarts:0});
  expect(await settings().getByText("Connect the native account on this computer before enabling Bot use.",{exact:true}).count()).toBe(0);
  await page.screenshot({path:join(captures.path,"01-connected-before-adoption.png")});
 });
 it("keeps the old route after rejection, then adopts the existing account without another login",async()=>{
  gateway.setFailAdoption(true);
  await settings().getByRole("button",{name:"Use connected Claude account",exact:true}).click();
  await expect.poll(async()=>Boolean(await settings().getByRole("alert").count())).toBe(true);
  expect(gateway.snapshot().harnesses[0]?.configuredAccessSourceId).toBe("matrix_included");
  expect(gateway.counters()).toEqual({completions:0,browserStarts:0,terminalStarts:0});
  await page.screenshot({path:join(captures.path,"02-adoption-rejected.png")});
  gateway.setFailAdoption(false);
  const retry=settings().getByRole("button",{name:"Use connected Claude account",exact:true});
  await retry.waitFor();await expect.poll(()=>retry.isEnabled()).toBe(true);await retry.click();
  await expect.poll(()=>gateway.counters().completions).toBe(1);
  await expect.poll(async()=>settings().getByRole("button",{name:"Use connected Claude account",exact:true}).count()).toBe(0);
  expect(gateway.snapshot().harnesses[0]).toMatchObject({accessSourceId:"owner_claude_profile",selectedAccountId:"owner_claude_profile",configuredEnabled:true});
  expect(gateway.counters()).toEqual({completions:1,browserStarts:0,terminalStarts:0});
  await page.screenshot({path:join(captures.path,"03-native-account-adopted.png")});
  await settings().getByRole("button",{name:"Refresh provider status",exact:true}).click();
  await expect.poll(async()=>settings().getByRole("button",{name:"Refresh provider status",exact:true}).isEnabled()).toBe(true);
  expect(await row().innerText()).toContain("Connected");expect(gateway.counters().completions).toBe(1);
 },30000);
});

suite("Electron Desktop Terminal-origin Claude authentication (synthetic native CLI)",()=>{
 let app:ElectronApplication,page:Page,profile:string;
 let gateway:Awaited<ReturnType<typeof startClaudeLegacyRecoveryGateway>>;
 let captures:ReturnType<typeof createEvidenceDirectory>;
 beforeAll(async()=>{
  captures=createEvidenceDirectory(process.env.MATRIX_SETTINGS_EVIDENCE_DIR?join(process.env.MATRIX_SETTINGS_EVIDENCE_DIR,"claude-terminal-sync"):undefined);
  gateway=await startClaudeLegacyRecoveryGateway({externalTerminal:true});profile=mkdtempSync(join(tmpdir(),"matrix-terminal-auth-electron-"));
  app=await _electron.launch({executablePath:createRequire(join(root,"desktop/package.json"))("electron") as string,args:[join(root,"desktop/out/main/index.js")],env:{...process.env,OPERATOR_GATEWAY_URL:gateway.url,OPERATOR_USER_DATA_DIR:profile}});
  page=await app.firstWindow();await dismissGettingStartedOnInteraction(page);
  await app.evaluate(({shell})=>{shell.openExternal=async()=>{};});
  await page.getByRole("button",{name:/create account/i}).waitFor();await page.evaluate(()=>window.operator.invoke("auth:start-device-flow",{}));
  await page.getByRole("button",{name:"Terminal",exact:true}).first().waitFor({timeout:15000});
  await page.getByRole("button",{name:"Open account menu",exact:true}).click();await page.getByRole("menuitem",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:"Agents & providers",exact:true}).click();
  const row=page.locator(".matrix-ap-rail-item").filter({hasText:"Claude"}).first();await row.waitFor();await row.click();
  const identity=await app.evaluate(({app})=>({appPath:app.getAppPath(),electron:process.versions.electron,chrome:process.versions.chrome}));
  writeFileSync(join(captures.path,"runtime.json"),JSON.stringify({...identity,source:process.env.MATRIX_BUILD_SHA??"working-tree",backend:"synthetic native CLI process; real metadata reader/store/owner routes; no paid inference"},null,2));
 },60000);
 afterAll(async()=>{try{if(app)await closeElectronApp(app);}finally{try{await gateway?.close();}finally{if(profile)rmSync(profile,{recursive:true,force:true});captures?.cleanup();}}});
 it("refreshes Terminal login, changed account and logout without a Settings login workflow or funding/grant changes",async()=>{
  const native=gateway.terminalAuthentication;if(!native)throw new Error("Native fixture required");
  const row=()=>page.locator(".matrix-ap-rail-item").filter({hasText:"Claude"}).first();
  await expect.poll(()=>row().innerText()).toContain("Not connected");const before=await native.configuration();
  const focus=()=>page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  await native.setStatus("first@example.test");await focus();await expect.poll(()=>row().innerText()).toContain("Connected");
  // Automatic detection updates the existing indicator; it must not substitute
  // a native account card for this separately saved historical execution route.
  expect(await page.locator(".matrix-ap-connected").count()).toBe(0);
  expect(await page.getByRole("button",{name:"Use connected Claude account",exact:true}).count()).toBe(0);
  await page.screenshot({path:join(captures.path,"01-terminal-connected.png")});
  await native.setStatus("second@example.test");await page.waitForTimeout(550);
  const replacement = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ai/provider-settings" && response.request().method() === "GET");
  await focus();
  const replacementSnapshot = await (await replacement).json();
  expect(replacementSnapshot.accounts.find((account:{id:string})=>account.id==="owner_claude_profile").connectionDetails.email).toBe("second@example.test");
  expect(await row().innerText()).toContain("Connected");
  expect(await page.locator(".matrix-ap-connected").count()).toBe(0);
  await native.setStatus(null);await page.waitForTimeout(550);await focus();await expect.poll(()=>row().innerText()).toContain("Not connected");
  await page.screenshot({path:join(captures.path,"02-terminal-logged-out.png")});
  expect(await native.configuration()).toBe(before);expect(gateway.counters()).toEqual({completions:0,browserStarts:0,terminalStarts:0});
  const snapshot=await native.store.getSnapshot({includeNativeAccountMetadata:true});
  expect(snapshot.harnesses.find(h=>h.id==="harness_kernel")).toMatchObject({enabled:false,configuredEnabled:false,configuredAccessSourceId:"owner_anthropic_profile",selectedAccountId:"owner_anthropic"});
  const bot=await(await fetch(`${gateway.url}/api/bot-connections?refresh=true`,{signal:AbortSignal.timeout(5000)})).json();
  expect(bot.connections[0].authorization).toEqual({revision:0,enabled:false,background:false});
 },30000);
});
