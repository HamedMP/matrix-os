import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { hermesSharedBrowserToolProjection } from "../../packages/gateway/src/chat/hermes-shared-browser-tools.js";

const prefix = [
  "import sys,types,copy,json",
  "NAME='mcp__matrix_shared_browser__shared_browser'",
  "def tool(name,kind='object'):return {'type':'function','function':{'name':name,'parameters':{'type':kind,'properties':{'marker':{'type':'string'}}}}}",
  "raw=[tool('read_file'),tool(NAME),tool('mcp__other__admin')]",
  "active=[tool('read_file'),tool('tool_search'),tool('tool_describe'),tool('tool_call')]",
  "cache={};calls=[]",
  "def native(enabled_toolsets=None,disabled_toolsets=None,quiet_mode=False,skip_tool_search_assembly=False):",
  " key=(tuple(enabled_toolsets or []),tuple(disabled_toolsets or []),quiet_mode,skip_tool_search_assembly)",
  " calls.append(key)",
  " if key not in cache:",
  "  base=raw if skip_tool_search_assembly else active",
  "  cache[key]=copy.deepcopy([t for t in base if not(t['function']['name']==NAME and 'mcp-matrix_shared_browser'in(disabled_toolsets or []))])",
  " return cache[key]",
  "module=types.ModuleType('model_tools');module.get_tool_definitions=native;sys.modules['model_tools']=module",
].join("\n");
function run(assertions: string[]) {
  const python = prefix + "\n" + hermesSharedBrowserToolProjection().join("\n") + "\n" + assertions.join("\n") + "\nprint(json.dumps({'passed':True}))\n";
  const result = spawnSync("python3", ["-c", python], { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ passed: true });
}

it("keeps native bridges and exposes only the sole same-scope shared browser schema", () => {
  run([
    "fn=module.get_tool_definitions;scope=['hermes-cli','mcp-matrix_shared_browser']",
    "value=fn(scope,[],True);names=[t['function']['name']for t in value]",
    "assert names==['read_file','tool_search','tool_describe','tool_call',NAME]",
    "assert value is not cache[(tuple(scope),(),True,False)]",
    "value[-1]['function']['parameters']['properties']['marker']['type']='number'",
    "assert raw[1]['function']['parameters']['properties']['marker']['type']=='string'",
    "assert cache[(tuple(scope),(),True,True)][1]['function']['parameters']['properties']['marker']['type']=='string'",
    "assert all(c[0]==tuple(scope)and c[2]is True for c in calls)",
  ]);
});
it("preserves disabled scopes, quiet cache boundaries and native raw bridge calls", () => {
  run([
    "fn=module.get_tool_definitions;scope=['hermes-cli','mcp-matrix_shared_browser']",
    "assert NAME in[t['function']['name']for t in fn(scope,[],True)]",
    "assert NAME not in[t['function']['name']for t in fn(scope,['mcp-matrix_shared_browser'],True)]",
    "assert fn(scope,[],True,True)is native(scope,[],True,True)",
    "assert NAME in[t['function']['name']for t in fn(scope,[],True)]",
    "assert len(cache[(tuple(scope),(),True,False)])==4",
  ]);
});
it.each(["duplicate_raw", "duplicate_raw_with_active", "missing_raw", "duplicate_active", "changed_active"])("fails closed for %s", kind => {
  run([
    "fn=module.get_tool_definitions",
    ...(kind === "duplicate_raw_with_active" ? ["raw=[tool(NAME),tool(NAME)];active=[tool(NAME)]"] : kind === "duplicate_raw" ? ["raw=[tool(NAME),tool(NAME)]"] : kind === "missing_raw" ? ["raw=[];active=[tool(NAME)]"] : kind === "duplicate_active" ? ["active=[tool(NAME),tool(NAME)]"] : ["active=[tool(NAME,'string')]"]),
    "try:fn([],[],True)",
    "except RuntimeError:pass",
    "else:raise AssertionError('invalid native scope accepted')",
  ]);
});

it("keeps an already-visible exact native schema without mutating its cache", () => {
  run([
    "active=[tool('read_file'),tool(NAME)]",
    "fn=module.get_tool_definitions;value=fn([],[],True)",
    "assert value is cache[((),(),True,False)]",
    "assert len(value)==2",
  ]);
});
