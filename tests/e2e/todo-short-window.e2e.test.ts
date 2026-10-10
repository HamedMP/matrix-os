import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
const root=resolve(__dirname,"../..");
const {chromium}=createRequire(resolve(root,"shell/package.json"))("@playwright/test");
function css(file:string):string{const path=resolve(root,file);return readFileSync(path,"utf8").replace(/@import\s+["']([^"']+)["'];/g,(_,imported:string)=>css(resolve(dirname(path),imported)));}
it.each([[360,300],[320,200],[960,700]])("keeps Todo capture and project task controls reachable at %i×%i",async(width,height)=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 try{const page=await browser.newPage({viewport:{width,height}});await page.route("**/*",(route:any)=>route.abort());
 const styles=css("home/apps/todo/src/styles.css")+css("home/apps/todo/src/design-refresh.css")+["gallery-family.css","app-identities.css","matrix-brand.css"].map(f=>css("home/apps/_shared/"+f)).join("");
 await page.setContent(`<html data-app="todo"><head><style>${styles}</style></head><body><div class="todo-app"><aside class="sidebar"><div class="brand">Todo</div><div class="nav-group"><button class="nav-item">Inbox</button><button class="nav-item">Today</button></div><div class="nav-group"><button class="nav-item">Owner project</button></div></aside><main class="content"><div class="content-head"><h1>Owner project</h1></div><form class="capture"><input id="capture" class="capture-input" placeholder="Add task"></form><div class="task-list">${Array.from({length:8},(_,i)=>`<article class="task-row"><button class="check" id="done-${i}">Done</button><button class="task-title" id="edit-${i}">Owner task ${i}</button></article>`).join("")}</div></main></div></body></html>`);
 for(const target of ["#capture","#edit-7","#done-7"]){await page.locator(target).scrollIntoViewIfNeeded();const b=await page.locator(target).boundingBox();expect(b!.y).toBeGreaterThanOrEqual(-1);expect(b!.y+b!.height).toBeLessThanOrEqual(height+1);expect(await page.locator(target).evaluate((e:HTMLElement)=>{const b=e.getBoundingClientRect();return e===document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)||e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})).toBe(true);}
 }finally{await browser.close();}
},15000);
