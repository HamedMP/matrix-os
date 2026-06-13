"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("operator", {
  version: process.env.npm_package_version ?? "dev"
});
