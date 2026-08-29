#!/usr/bin/env node

import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function resolveFixtureManifestName(platform, channel) {
  if (!["mac", "windows", "linux"].includes(platform)) {
    throw new Error("--platform must be one of mac, windows, or linux");
  }
  if (!channel || !["stable", "beta", "canary", "dev"].includes(channel)) {
    throw new Error("--channel must be one of stable, beta, canary, or dev");
  }
  const base = channel === "stable" ? "latest" : channel;
  if (platform === "windows") return `${base}.yml`;
  return `${base}-${platform}.yml`;
}

async function main() {
  const args = process.argv.slice(2);

  function option(name) {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    return args[index + 1];
  }

  const channel = option("--channel");
  const platform = option("--platform") ?? "mac";
  const version = option("--version");
  const portFile = option("--port-file");
  const printOnly = args.includes("--print");

  const manifestName = resolveFixtureManifestName(platform, channel);
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error("--version must be a safe semantic version");
  }
  if (!printOnly && !portFile) {
    throw new Error("--port-file is required when starting the fixture server");
  }

  const sha512 = Buffer.alloc(64).toString("base64");
  const manifest = [
    `version: ${version}`,
    "files:",
    "  - url: fixture.zip",
    `    sha512: ${sha512}`,
    "    size: 1",
    "path: fixture.zip",
    `sha512: ${sha512}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    "releaseNotes: |-",
    "  Packaged updater fixture probe.",
    "",
  ].join("\n");

  if (printOnly) {
    process.stdout.write(manifest);
  } else {
    const server = createServer((request, response) => {
      if (
        request.method !== "GET"
        || new URL(request.url ?? "/", "http://localhost").pathname !== `/${manifestName}`
      ) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(manifest),
        "Content-Type": "text/yaml; charset=utf-8",
      });
      response.end(manifest);
      console.info(`[fixture] served ${manifestName}`);
    });
    server.requestTimeout = 5_000;
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Fixture server did not bind to a TCP port");
      }
      await writeFile(portFile, `${address.port}\n`, { encoding: "utf8" });
      console.info(`[fixture] listening on 127.0.0.1:${address.port}`);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
