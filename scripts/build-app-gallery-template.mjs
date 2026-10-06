#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)),
  template = resolve(root, "home/app-templates/connected-starter");
const vite = resolve(root, "node_modules/vite/bin/vite.js");
await import(
  pathToFileURL(resolve(template, "scripts/sync-inventory.mjs")).href
);
await stat(vite);
await new Promise((accept, reject) => {
  const child = spawn(process.execPath, [vite, "build"], {
    cwd: template,
    stdio: "inherit",
    env: { ...process.env, CI: "1" },
  });
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error("Connected starter build timed out"));
  }, 180000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    code === 0 ? accept() : reject(new Error("Connected starter build failed"));
  });
});
const html = await readFile(resolve(template, "dist/index.html"), "utf8");
if (html.split("__MATRIX_APP_DEFINITION__").length !== 2)
  throw new Error(
    "Connected starter definition placeholder is missing or duplicated",
  );
console.log(
  "Portable connected starter built with one safe definition injection point.",
);
