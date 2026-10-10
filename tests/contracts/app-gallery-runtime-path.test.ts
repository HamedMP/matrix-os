import { expect, it } from "vitest";
import { canonicalAppRuntimeCatalogPath } from "../../packages/contracts/src/app-gallery-bridge-policy";
import { canonicalOsViewCatalogPath } from "../../packages/contracts/src/os-view";
const root = (length: number) => {const count=Math.ceil((length-4)/256);return "apps/" + Array.from({length:count}, (_,i) => "a".repeat(i===count-1 ? length-5-(count-1)*256 : 255)).join("/");};
it.each([2049,4096])("accepts %i-character runtime roots while persisted references remain bounded", length => {
 const path = root(length); expect(path.length).toBe(length);
 for (const row of [{path:`/files/${path}/index.html`},{file:`${path.slice(5)}/index.html`},{path:`${path}/dist/index.html`}]) {
  expect(canonicalAppRuntimeCatalogPath(row)).toBe(("path" in row ? row.path!.replace(/^\/files\//,"") : "apps/"+row.file));
  expect(canonicalOsViewCatalogPath(row)).toBeNull();
 }
});
it.each(["apps/x%backup/index.html","apps/x?backup/index.html","apps/x#backup/index.html","apps/x:backup/index.html","apps/x\\backup/index.html","apps/../x/index.html","apps/x//index.html","apps/x\n/index.html",root(4097)+"/index.html","apps/"+"x".repeat(256)+"/index.html","apps/"+Array(17).fill("x").join("/")+"/index.html"])("rejects ambiguous, unsafe or oversized runtime path %s",path=>{
 expect(canonicalAppRuntimeCatalogPath({path})).toBeNull();
});
it("retains safe legacy and ordinary catalog paths",()=>{
 for(const path of ["apps/notes.html","apps/folder/index.html","apps/folder/dist/index.html"])
  expect(canonicalAppRuntimeCatalogPath({path:`/files/${path}`})).toBe(path);
});
